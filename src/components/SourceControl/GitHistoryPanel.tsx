import { useEffect, useMemo, useState } from "react";
import type { GitCommitDetails, GitCommitInfo } from "../../commands";
import { useGitHistoryStore } from "../../stores/gitHistoryStore";
import { useDiffStore } from "../../stores/diffStore";
import { commitDiffSides } from "../../utils/commitDiffSides";
import { buildCommitTree, type CommitTreeNode } from "../../utils/gitCommitTree";

const STATUS_LABELS: Record<string, string> = {
  M: "已修改",
  A: "已添加",
  D: "已删除",
  R: "已重命名",
  C: "已复制",
  U: "冲突",
  "?": "已更改",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function badgeKey(status: string): string {
  return status === "?" ? "q" : status.toLowerCase();
}

/** Compact relative time ("3 小时前"); falls back to a date for old commits. */
function relativeTime(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ts * 1000) / 1000));
  if (seconds < 10) return "刚才";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds} 秒前`;
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

function absoluteTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN");
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : undefined, flex: "none" }}
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface CommitRowProps {
  commit: GitCommitInfo;
  selected: boolean;
  onClick: () => void;
}

function CommitRow({ commit, selected, onClick }: CommitRowProps) {
  return (
    <button
      type="button"
      className={`gh-commit${selected ? " selected" : ""}`}
      onClick={onClick}
      title={`${commit.hash}\n${commit.author} — ${absoluteTime(commit.date)}`}
    >
      <span className="gh-commit-short">{commit.shortHash}</span>
      <span className="gh-commit-main">
        <span className="gh-commit-message">{commit.message || "（无提交说明）"}</span>
        <span className="gh-commit-meta">
          {commit.author}
          <span className="gh-commit-dot">·</span>
          {relativeTime(commit.date)}
        </span>
      </span>
    </button>
  );
}

interface DirNodeProps {
  node: CommitTreeNode;
  onChange: (path: string) => void;
  collapsed: ReadonlySet<string>;
}

function DirNode({ node, collapsed, onChange }: DirNodeProps) {
  const isCollapsed = collapsed.has(node.path);
  const children = isCollapsed ? [] : node.children ?? [];
  return (
    <>
      <button type="button" className="gh-file-row gh-dir" onClick={() => onChange(node.path)} title={node.path}>
        <ChevronIcon open={!isCollapsed} />
        <span className="gh-dir-name">{node.name}</span>
      </button>
      {children.map((child) =>
        child.kind === "dir" ? (
          <DirNode key={child.path} node={child} collapsed={collapsed} onChange={onChange} />
        ) : (
          <FileRow key={child.path} file={child} />
        ),
      )}
    </>
  );
}

interface FileRowProps {
  file: CommitTreeNode;
}

function FileRow({ file }: FileRowProps) {
  const openDiff = useDiffStore((s) => s.open);
  const status = file.status ?? "?";
  const doOpen = () => {
    const selected = useGitHistoryStore.getState().selected;
    const details = useGitHistoryStore.getState().details;
    if (!selected || !details) return;
    const { original, modified } = commitDiffSides(
      { path: file.path, status, oldPath: file.oldPath ?? null },
      details.commit.hash,
      details.parentHash,
    );
    void openDiff(file.path, original, modified);
  };
  return (
    <div className="gh-file-row gh-file">
      <button
        type="button"
        className="gh-file-open"
        title={file.oldPath ? `${file.oldPath} → ${file.path}（${statusLabel(status)}）— 查看 Diff` : `${file.path}（${statusLabel(status)}）— 查看 Diff`}
        onClick={doOpen}
      >
        <span className={`sc-badge sc-badge-${badgeKey(status)}`}>{status}</span>
        <span className="gh-file-path">{file.path}</span>
      </button>
    </div>
  );
}

interface CommitFilesProps {
  details: GitCommitDetails;
}

function CommitFiles({ details }: CommitFilesProps) {
  const tree = useMemo(() => buildCommitTree(details.files), [details.files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (tree.length === 0) {
    return <p className="sc-empty">该提交没有更改文件</p>;
  }
  return (
    <div className="gh-files">
      {tree.map((node) =>
        node.kind === "dir" ? (
          <DirNode key={node.path} node={node} collapsed={collapsed} onChange={toggle} />
        ) : (
          <FileRow key={node.path} file={node} />
        ),
      )}
    </div>
  );
}

function CommitDetail({ details }: { details: GitCommitDetails }) {
  const commit = details.commit;
  const parentShort = details.parentHash ? details.parentHash.slice(0, 7) : "—";
  return (
    <div className="gh-detail">
      <div className="gh-detail-head">
        <span className="gh-detail-short">{commit.shortHash}</span>
        {details.parentHash ? (
          <span className="gh-detail-parent" title={`parent: ${details.parentHash}`}>
            父提交 {parentShort}
          </span>
        ) : (
          <span className="gh-detail-parent">初始提交（无父提交）</span>
        )}
      </div>
      <div className="gh-detail-message" title={commit.message}>
        {commit.message || "（无提交说明）"}
      </div>
      <div className="gh-detail-meta">
        <span>{commit.author}</span>
        {commit.email && <span>{commit.email}</span>}
        <span>{absoluteTime(commit.date)}</span>
      </div>
      <div className="gh-detail-files-head">
        更改文件（{details.files.length}）
      </div>
      <CommitFiles details={details} />
    </div>
  );
}

/** A rejected commit fetch (unknown hash) — a transient state the panel clears
 *  by re-selecting; shown inline instead of throwing an error page. */
function GitHistoryPanel() {
  const commits = useGitHistoryStore((s) => s.commits);
  const loading = useGitHistoryStore((s) => s.loading);
  const loadingMore = useGitHistoryStore((s) => s.loadingMore);
  const hasMore = useGitHistoryStore((s) => s.hasMore);
  const error = useGitHistoryStore((s) => s.error);
  const selected = useGitHistoryStore((s) => s.selected);
  const details = useGitHistoryStore((s) => s.details);
  const detailsLoading = useGitHistoryStore((s) => s.detailsLoading);
  const detailsError = useGitHistoryStore((s) => s.detailsError);
  const load = useGitHistoryStore((s) => s.load);
  const loadMore = useGitHistoryStore((s) => s.loadMore);
  const select = useGitHistoryStore((s) => s.select);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && commits.length === 0) {
    return <p className="sc-hint">正在读取提交记录…</p>;
  }

  return (
    <div className="gh-panel">
      {error && <p className="sc-error">{error}</p>}
      {!error && commits.length === 0 && <p className="sc-hint">还没有提交记录。</p>}
      {commits.length > 0 && (
        <>
          <div className="gh-list">
            {commits.map((commit) => (
              <CommitRow
                key={commit.hash}
                commit={commit}
                selected={selected?.hash === commit.hash}
                onClick={() => void select(commit)}
              />
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              className="gh-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "正在加载…" : "加载更多"}
            </button>
          )}
        </>
      )}
      {selected && detailsLoading && <p className="sc-hint">正在读取提交详情…</p>}
      {selected && detailsError && <p className="sc-error">{detailsError}</p>}
      {selected && details && !detailsLoading && <CommitDetail details={details} />}
    </div>
  );
}

export default GitHistoryPanel;