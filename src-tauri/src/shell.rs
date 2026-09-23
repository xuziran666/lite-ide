use std::path::PathBuf;

/// Locate an executable by name on the `PATH`. Returns the first match.
#[cfg(windows)]
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Shells actually present on this machine, most preferred first. On Windows
/// the probe order is PowerShell 7, Windows PowerShell, then `cmd.exe`. On Unix
/// `$SHELL` is preferred, with `/bin/sh` as the fallback.
pub fn available_shells() -> Vec<String> {
    #[cfg(windows)]
    {
        ["pwsh.exe", "powershell.exe", "cmd.exe"]
            .iter()
            .filter_map(|name| find_executable(name))
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    }
    #[cfg(not(windows))]
    {
        let mut out = Vec::new();
        if let Some(shell) = std::env::var("SHELL").ok().filter(|s| !s.is_empty()) {
            out.push(shell);
        }
        out.push("/bin/sh".to_string());
        out.sort();
        out.dedup();
        out
    }
}

/// The shell to launch for a new terminal session when no explicit shell is
/// configured, chosen from whatever is installed on the machine.
pub fn current_shell() -> String {
    let mut shells = available_shells();
    if let Some(first) = shells.drain(..1).next() {
        return first;
    }
    #[cfg(windows)]
    {
        "cmd.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        "/bin/sh".to_string()
    }
}