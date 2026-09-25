import { useCallback, useEffect, useState } from "react";
import type { GitFileStatus } from "../../commands";
import { gitCommit } from "../../commands";
import { useGitStore } from "../../stores/gitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useDiffStore } from "../../stores/diffStore";
import { useGitHistoryStore } from "../../stores/gitHistoryStore";
import { diffSidesFor, type DiffGroup } from "../../utils/diffSides";
import GitHistoryPanel from "./GitHistoryPanel";

const STATUS_LABELS: Record<string, string> = {
  M: "已修改",
  A: "已添加",
  D: "已删除",
  R: "已重命名",
  C: "已复制",
  U: "冲突",
  "?": "未跟踪",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Whether the worktree no longer contains the file (staged or unstaged D). */
function isDeletedFile(file: GitFileStatus): boolean {
  return file.stagedStatus === "D" || file.unstagedStatus === "D";
}

function badgeKey(status: string): string {
  return status === "?" ? "q" : status.toLowerCase();
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.5 2.5v2.2h-2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StageAllIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2v7M5 6l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function UnstageAllIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 14V7M5 10l3-3 3 3M3 3h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={open ? "sc-section-chevron open" : "sc-section-chevron"}
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface SectionHeaderProps {
  label: string;
  count: number;
  actionTitle?: string;
  actionIcon?: "stage-all" | "unstage-all";
  disabled?: boolean;
  open: boolean;
  onToggle: () => void;
  onAction?: () => void;
}

function SectionHeader({ label, count, actionTitle, actionIcon, disabled, open, onToggle, onAction }: SectionHeaderProps) {
  return (
    <div className="sc-group-header">
      <button type="button" className="sc-section-toggle" onClick={onToggle} title={open ? "折叠" : "展开"}>
        <ChevronIcon open={open} />
      </button>
      <button type="button" className="sc-section-label" onClick={onToggle} title={open ? "折叠" : "展开"}>
        {label}
      </button>
      <span className="sc-group-count">{count}</span>
      {actionIcon && onAction && (
        <button type="button" className="sc-icon-button" title={actionTitle} onClick={onAction} disabled={disabled ?? count === 0}>
          {actionIcon === "stage-all" ? <StageAllIcon /> : <UnstageAllIcon />}
        </button>
      )}
    </div>
  );
}

interface FileRowProps {
  file: GitFileStatus;
  action: "stage" | "unstage";
  /** The group the row belongs to: decides which two revisions to compare. */
  group: DiffGroup;
}

function FileRow({ file, action, group }: FileRowProps) {
  const busy = useGitStore((s) => s.busy);
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);
  const openDiff = useDiffStore((s) => s.open);
  const label = statusLabel(file.status);
  const deleted = isDeletedFile(file);

  const doAction = () => {
    if (action === "stage") void stage([file.path]);
    else void unstage([file.path]);
  };

  const doOpen = () => {
    const { original, modified } = diffSidesFor(file, group);
    void openDiff(file.path, original, modified);
  };

  return (
    <div className={`sc-row${deleted ? " sc-row-deleted" : ""}`}>
      <button
        type="button"
        className="sc-row-open"
        title={
          deleted
            ? `${file.path}（已删除）— 查看删除 Diff`
            : file.renamedFrom
              ? `${file.renamedFrom} → ${file.path}（${label}）— 查看 Diff`
              : `${file.path}（${label}）— 查看 Diff`
        }
        onClick={doOpen}
      >
        <span className={`sc-badge sc-badge-${badgeKey(file.status)}`}>{file.status}</span>
        <span className="sc-row-path">{file.path}</span>
      </button>
      <button
        type="button"
        className="sc-row-action"
        title={action === "stage" ? `暂存 ${file.path}` : `取消暂存 ${file.path}`}
        onClick={doAction}
        disabled={busy}
      >
        {action === "stage" ? <PlusIcon /> : <MinusIcon />}
      </button>
    </div>
  );
}

interface CommitBoxProps {
  hasStaged: boolean;
  busy: boolean;
}

function CommitBox({ hasStaged, busy }: CommitBoxProps) {
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCommit = hasStaged && message.trim().length > 0 && !busy && !committing;

  const doCommit = useCallback(async () => {
    if (!canCommit) return;
    setCommitting(true);
    setError(null);
    try {
      await gitCommit(message);
      setMessage("");
      void useGitStore.getState().refresh();
      void useGitHistoryStore.getState().load();
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }, [canCommit, message]);

  return (
    <div className="sc-commit">
      <textarea
        className="sc-commit-input"
        placeholder={hasStaged ? "提交说明（Ctrl+Enter 提交）…" : "先暂存更改后再提交…"}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            void doCommit();
          }
        }}
        rows={3}
      />
      {error && <p className="sc-commit-error">{error}</p>}
      <button
        type="button"
        className="sc-commit-button"
        disabled={!canCommit}
        onClick={() => void doCommit()}
      >
        {committing ? "提交中…" : "提交"}
      </button>
    </div>
  );
}

function SourceControlPanel() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isRepository = useGitStore((s) => s.isRepository);
  const loading = useGitStore((s) => s.loading);
  const busy = useGitStore((s) => s.busy);
  const error = useGitStore((s) => s.error);
  const files = useGitStore((s) => s.files);
  const refresh = useGitStore((s) => s.refresh);
  const stageAll = useGitStore((s) => s.stageAll);
  const unstageAll = useGitStore((s) => s.unstageAll);
  const [changesOpen, setChangesOpen] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);

  // Refresh once when the panel becomes visible (or on workspace change) so
  // the shown status is current even if no file-system event arrived since
  // the last load. The result lists are kept while `loading` to avoid flicker.
  useEffect(() => {
    if (!workspacePath) return;
    const store = useGitStore.getState();
    if (!store.loading) void store.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  // One refresh reloads the status, the staged list and the history together.
  const doRefresh = () => {
    void refresh();
    void useGitHistoryStore.getState().load();
  };

  const changes = files.filter((f) => f.unstaged);
  const staged = files.filter((f) => f.staged);

  return (
    <div className="panel sc-panel">
      <div className="sc-header">
        <span className="sc-title">源代码管理</span>
        {isRepository && (
          <div className="sc-header-actions">
            <button type="button" className="sc-icon-button" title="刷新" onClick={doRefresh} disabled={busy}>
              <RefreshIcon />
            </button>
          </div>
        )}
      </div>
      <div className="sc-scroll">
        {!workspacePath && <p className="sc-hint">未打开工作区</p>}
        {workspacePath && error && <p className="sc-error">{error}</p>}
        {workspacePath && !error && !isRepository && !loading && (
          <p className="sc-hint">没有 Git 仓库</p>
        )}
        {workspacePath && !error && isRepository && loading && files.length === 0 && (
          <p className="sc-hint">正在读取…</p>
        )}
        {workspacePath && !error && isRepository && !loading && (
          <>
            <CommitBox hasStaged={staged.length > 0} busy={busy} />
            <SectionHeader
              label="已暂存的更改"
              count={staged.length}
              actionTitle="全部取消暂存"
              actionIcon="unstage-all"
              disabled={busy || staged.length === 0}
              open={stagedOpen}
              onToggle={() => setStagedOpen((v) => !v)}
              onAction={() => void unstageAll()}
            />
            {stagedOpen &&
              (staged.length === 0 ? (
                <p className="sc-empty">没有已暂存的更改</p>
              ) : (
                staged.map((file) => (
                  <FileRow key={file.path} file={file} action="unstage" group="staged" />
                ))
              ))}
            <SectionHeader
              label="更改"
              count={changes.length}
              actionTitle="全部暂存"
              actionIcon="stage-all"
              disabled={busy || changes.length === 0}
              open={changesOpen}
              onToggle={() => setChangesOpen((v) => !v)}
              onAction={() => void stageAll()}
            />
            {changesOpen &&
              (changes.length === 0 ? (
                <p className="sc-empty">没有更改</p>
              ) : (
                changes.map((file) => (
                  <FileRow key={file.path} file={file} action="stage" group="changes" />
                ))
              ))}
            <SectionHeader
              label="历史"
              count={0}
              open={historyOpen}
              onToggle={() => setHistoryOpen((v) => !v)}
            />
            {historyOpen && <GitHistoryPanel />}
          </>
        )}
      </div>
    </div>
  );
}

export default SourceControlPanel;