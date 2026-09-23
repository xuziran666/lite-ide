use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::error::io_error;

/// Flush accumulated terminal output once it reaches this size.
const FLUSH_BYTES: usize = 4096;
/// Maximum delay before partial terminal output is flushed.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// A running pseudo-terminal: the pty handle, its input writer and the child
/// shell process.
pub struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Shared state between the pty reader thread and the channel flusher thread.
struct OutputBuf {
    pending: Vec<u8>,
    eof: bool,
}

type SharedBuf = Arc<(Mutex<OutputBuf>, Condvar)>;

/// Lock the output buffer, recovering from a poisoned lock (a prior panic in
/// another thread) by continuing with the shared state rather than panicking.
fn lock_buf(lock: &Mutex<OutputBuf>) -> std::sync::MutexGuard<'_, OutputBuf> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl TerminalSession {
    pub fn spawn(
        shell: String,
        cwd: Option<PathBuf>,
        channel: Channel<Vec<u8>>,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system
            .openpty(size)
            .map_err(|e| io_error("open pseudo terminal", e))?;

        let mut cmd = CommandBuilder::new(shell);
        if let Some(dir) = &cwd {
            cmd.cwd(dir);
        }
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| io_error("spawn shell in terminal", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| io_error("take terminal writer", e))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| io_error("take terminal reader", e))?;

        spawn_output_thread(reader, channel);

        Ok(Self {
            master: pair.master,
            writer,
            child,
        })
    }

    /// Write input from the user (as UTF-8) into the pty.
    pub fn write(&mut self, data: &str) -> Result<(), String> {
        self.writer
            .write_all(data.as_bytes())
            .map_err(|e| io_error("write to terminal", e))
    }

    /// Inform the pty that the visible terminal size changed.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        self.master
            .resize(size)
            .map_err(|e| io_error("resize terminal", e))
    }

    /// Terminate the shell (and, on Windows, its child process tree) so no
    /// orphan processes are left behind.
    pub fn kill(&mut self) {
        #[cfg(windows)]
        if let Some(pid) = self.child.process_id() {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output();
        }
        let _ = self.child.kill();
    }
}

/// Safety net: a session that is dropped without being explicitly killed
/// (e.g. the map is cleared, or the terminal state is replaced) still
/// terminates its shell instead of leaving an orphan process behind.
impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Read the pty output into a shared buffer; a flusher thread batches it into
/// bounded 4KB/16ms chunks and sends them over the channel. A final empty chunk
/// signals that the shell has exited.
fn spawn_output_thread(mut reader: Box<dyn Read + Send>, channel: Channel<Vec<u8>>) {
    let shared: SharedBuf = Arc::new((
        Mutex::new(OutputBuf {
            pending: Vec::new(),
            eof: false,
        }),
        Condvar::new(),
    ));

    let reader_shared = Arc::clone(&shared);
    std::thread::spawn(move || {
        let (lock, cvar) = &*reader_shared;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    lock_buf(lock).eof = true;
                    cvar.notify_all();
                    break;
                }
                Ok(n) => {
                    let mut guard = lock_buf(lock);
                    guard.pending.extend_from_slice(&buf[..n]);
                    drop(guard);
                    cvar.notify_all();
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    lock_buf(lock).eof = true;
                    cvar.notify_all();
                    break;
                }
            }
        }
    });

    let flusher_shared = Arc::clone(&shared);
    std::thread::spawn(move || {
        let (lock, cvar) = &*flusher_shared;
        let mut last_flush = Instant::now();
        loop {
            let wait = FLUSH_INTERVAL.saturating_sub(last_flush.elapsed());
            let guard = lock_buf(lock);
            let (mut guard, _) = cvar
                .wait_timeout(guard, wait)
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            if guard.eof {
                if guard.pending.is_empty() {
                    drop(guard);
                    // Empty chunk = exit marker.
                    let _ = channel.send(Vec::new());
                    break;
                }
                let data = std::mem::take(&mut guard.pending);
                drop(guard);
                let _ = channel.send(data);
                last_flush = Instant::now();
                continue;
            }

            let due = last_flush.elapsed() >= FLUSH_INTERVAL;
            let full = guard.pending.len() >= FLUSH_BYTES;
            if !guard.pending.is_empty() && (due || full) {
                let data = std::mem::take(&mut guard.pending);
                drop(guard);
                let _ = channel.send(data);
                last_flush = Instant::now();
            }
        }
    });
}