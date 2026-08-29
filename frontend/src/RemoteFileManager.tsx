import {
  ArrowLeft,
  Check,
  ChevronRight,
  File,
  FileArchive,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  Trash2,
  Unplug,
  X
} from "lucide-react";
import { FormEvent, useCallback, useMemo, useState } from "react";
import { deleteRemoteFiles, listRemoteFiles } from "./api";
import { bytes, compactDate } from "./format";
import type { Me, RemoteFileEntry, RemoteFileKind, RemoteFileListing } from "./types";

type SortMode = "size-desc" | "name-asc" | "modified-desc" | "kind-asc";

function entryIcon(entry: RemoteFileEntry) {
  if (entry.kind === "directory") return <Folder size={19} fill="currentColor" />;
  if (entry.kind === "symlink") return <File size={18} />;
  const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].includes(extension)) {
    return <FileArchive size={18} />;
  }
  if (["js", "ts", "tsx", "jsx", "py", "sh", "json", "yaml", "yml", "toml"].includes(extension)) {
    return <FileCode2 size={18} />;
  }
  if (["txt", "md", "log", "csv", "tex"].includes(extension)) {
    return <FileText size={18} />;
  }
  return <File size={18} />;
}

function kindLabel(kind: RemoteFileKind): string {
  if (kind === "directory") return "文件夹";
  if (kind === "symlink") return "链接";
  if (kind === "file") return "文件";
  return "其他";
}

function pathName(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function sortEntries(entries: RemoteFileEntry[], mode: SortMode): RemoteFileEntry[] {
  return [...entries].sort((left, right) => {
    if (mode === "size-desc") {
      return right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name, "zh-CN");
    }
    if (mode === "modified-desc") {
      return Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt);
    }
    if (mode === "kind-asc") {
      return left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name, "zh-CN");
    }
    return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
  });
}

interface DeleteDialogProps {
  entries: RemoteFileEntry[];
  onClose: () => void;
  onDeleted: (password: string, count: number) => void;
}

function DeleteDialog({ entries, onClose, onDeleted }: DeleteDialogProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const total = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await deleteRemoteFiles(
        password,
        entries.map((entry) => entry.path),
        confirmation
      );
      onDeleted(password, result.deleted);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop file-delete-backdrop" role="presentation">
      <form className="modal-card file-delete-modal" onSubmit={submit}>
        <div className="file-delete-title">
          <span><Trash2 size={20} /></span>
          <div>
            <h3>永久删除 {entries.length} 个项目？</h3>
            <p>预计释放 {bytes(total)}。文件不会进入废纸篓，也无法通过此工具恢复。</p>
          </div>
        </div>
        <div className="irreversible-warning">
          <ShieldAlert size={17} />
          <span>这是不可恢复的操作。请核对下方路径后再继续。</span>
        </div>
        <div className="delete-file-list">
          {entries.slice(0, 8).map((entry) => (
            <div key={entry.path}>
              <span>{entryIcon(entry)}</span>
              <strong>{entry.name}</strong>
              <em>{bytes(entry.sizeBytes)}</em>
            </div>
          ))}
          {entries.length > 8 && <p>另有 {entries.length - 8} 个项目</p>}
        </div>
        <label>
          再次输入 SSH 密码
          <input
            autoFocus
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          输入“永久删除”确认
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="永久删除"
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button
            className="danger-button"
            disabled={!password || confirmation !== "永久删除" || loading}
          >
            {loading ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
            {loading ? "正在删除" : "永久删除"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface RemoteFileManagerProps {
  user: Me;
  password: string;
  onPasswordChange: (password: string) => void;
  onToast: (message: string) => void;
}

export default function RemoteFileManager({
  user,
  password,
  onPasswordChange,
  onToast
}: RemoteFileManagerProps) {
  const [listing, setListing] = useState<RemoteFileListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("size-desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteEntries, setDeleteEntries] = useState<RemoteFileEntry[]>([]);

  const loadDirectory = useCallback(async (
    targetPath?: string,
    nextPassword = password,
    forceRefresh = false
  ) => {
    if (!nextPassword) {
      setError("请输入 SSH 密码后查询主目录");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const nextListing = await listRemoteFiles(
        nextPassword,
        targetPath,
        forceRefresh
      );
      setListing(nextListing);
      setSelected(new Set());
      setSearch("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [password]);

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? (listing?.entries ?? []).filter((entry) => entry.name.toLowerCase().includes(query))
      : (listing?.entries ?? []);
    return sortEntries(filtered, sortMode);
  }, [listing, search, sortMode]);

  const sizeEntries = useMemo(
    () => sortEntries(listing?.entries ?? [], "size-desc"),
    [listing]
  );
  const selectedEntries = useMemo(
    () => (listing?.entries ?? []).filter((entry) => selected.has(entry.path)),
    [listing, selected]
  );

  function toggleSelected(entry: RemoteFileEntry) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((current) => {
      const allSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => current.has(entry.path));
      if (allSelected) return new Set();
      return new Set(visibleEntries.map((entry) => entry.path));
    });
  }

  function disconnect() {
    onPasswordChange("");
    setListing(null);
    setSelected(new Set());
    setError("");
  }

  async function reconnect(event: FormEvent) {
    event.preventDefault();
    await loadDirectory(undefined, password);
  }

  function finishDelete(deletePassword: string, count: number) {
    setDeleteEntries([]);
    onPasswordChange(deletePassword);
    onToast(`已永久删除 ${count} 个项目`);
    if (listing) void loadDirectory(listing.path, deletePassword, true);
  }

  if (!listing) {
    return (
      <section className="file-connect-page">
        <div className="file-connect-card">
          <div className="file-connect-art">
            <div className="server-orbit"><Server size={34} /></div>
            <span className="connection-line" />
            <div className="folder-orbit"><FolderOpen size={34} /></div>
          </div>
          <div>
            <span className="eyebrow">远程文件管家</span>
            <h2>查询 {user.username} 的主目录</h2>
            <p>
              通过 SSH 连接 {user.host}:{user.port}。密码只保留在当前页面内存中，
              不会写入浏览器存储或日志。点击查询后会统计目录大小，大目录需要耐心等待。
            </p>
          </div>
          <form className="file-connect-form" onSubmit={reconnect}>
            <label>
              SSH 密码
              <span className="input-with-icon">
                <KeyRound size={16} />
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => onPasswordChange(event.target.value)}
                  placeholder="输入当前账户密码"
                />
              </span>
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="primary-button" disabled={!password || loading}>
              {loading ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}
              {loading ? "正在查询，请等待" : "查询主目录"}
            </button>
          </form>
          <div className="file-scope-note">
            <ShieldAlert size={15} />
            浏览和删除范围仅限此 SSH 账户的主目录，权限仍由远程 Linux 服务器决定。
          </div>
        </div>
      </section>
    );
  }

  const relativeParts = listing.path
    .slice(listing.home.length)
    .split("/")
    .filter(Boolean);
  const crumbs = [
    { label: user.username, path: listing.home },
    ...relativeParts.map((part, index) => ({
      label: part,
      path: `${listing.home}/${relativeParts.slice(0, index + 1).join("/")}`
    }))
  ];
  const maxSize = sizeEntries[0]?.sizeBytes ?? 0;
  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selected.has(entry.path));

  return (
    <section className="file-manager-page">
      <div className="finder-shell">
        <aside className="finder-sidebar">
          <div className="finder-side-title">
            <HardDrive size={17} />
            <span>位置</span>
          </div>
          <button className="finder-location active" onClick={() => void loadDirectory(listing.home)}>
            <FolderOpen size={17} />
            <span>主目录</span>
          </button>
          <div className="finder-server-card">
            <span className="connection-dot" />
            <div>
              <strong>{user.host}</strong>
              <span>{user.username} · SSH {user.port}</span>
            </div>
          </div>
          <div className="finder-scope">
            <span>安全范围</span>
            <code>{listing.home}</code>
          </div>
          <button className="finder-disconnect" onClick={disconnect}>
            <Unplug size={15} />
            断开文件连接
          </button>
        </aside>

        <div className="finder-main">
          <div className="finder-toolbar">
            <div className="finder-nav-buttons">
              <button
                className="icon-button"
                disabled={!listing.parent || loading}
                onClick={() => listing.parent && void loadDirectory(listing.parent)}
                title="返回上级目录"
              >
                <ArrowLeft size={16} />
              </button>
              <button
                className="icon-button"
                disabled={loading}
                onClick={() => void loadDirectory(listing.path, password, true)}
                title="重新查询当前目录"
              >
                <RefreshCw className={loading ? "spin" : ""} size={16} />
              </button>
            </div>
            <nav className="finder-breadcrumbs" aria-label="当前目录">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path}>
                  {index > 0 && <ChevronRight size={14} />}
                  <button onClick={() => void loadDirectory(crumb.path)}>{crumb.label}</button>
                </span>
              ))}
            </nav>
            <label className="finder-search">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索当前文件夹"
              />
              {search && <button onClick={() => setSearch("")} title="清除搜索"><X size={14} /></button>}
            </label>
          </div>

          {error && <div className="file-inline-error"><ShieldAlert size={16} />{error}</div>}
          {listing.truncated && (
            <div className="file-inline-warning">
              当前目录项目过多，仅展示前 500 个项目。建议进入子目录后再清理。
            </div>
          )}

          <div className="finder-content">
            <div className="file-list-panel">
              <div className="file-list-summary">
                <div>
                  <strong>{pathName(listing.path)}</strong>
                  <span>
                    {listing.entries.length} 个项目 · {bytes(listing.totalBytes)} ·
                    {listing.cached ? " 使用缓存" : ` 查询于 ${compactDate(listing.scannedAt)}`}
                  </span>
                </div>
                <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                  <option value="size-desc">大小：从大到小</option>
                  <option value="name-asc">名称：A 到 Z</option>
                  <option value="modified-desc">修改时间：最新</option>
                  <option value="kind-asc">类型</option>
                </select>
              </div>
              <div className="file-table-wrap">
                <table className="finder-table">
                  <thead>
                    <tr>
                      <th className="selection-cell">
                        <button
                          className={allVisibleSelected ? "select-box checked" : "select-box"}
                          onClick={selectAllVisible}
                          title={allVisibleSelected ? "取消全选" : "全选当前结果"}
                        >
                          {allVisibleSelected && <Check size={12} />}
                        </button>
                      </th>
                      <th>名称</th>
                      <th>大小</th>
                      <th>类型</th>
                      <th>修改时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEntries.map((entry) => {
                      const isSelected = selected.has(entry.path);
                      return (
                        <tr
                          key={entry.path}
                          className={isSelected ? "selected" : ""}
                          onClick={() => toggleSelected(entry)}
                          onDoubleClick={() => entry.kind === "directory" && void loadDirectory(entry.path)}
                        >
                          <td className="selection-cell">
                            <button className={isSelected ? "select-box checked" : "select-box"}>
                              {isSelected && <Check size={12} />}
                            </button>
                          </td>
                          <td>
                            <div className={`file-name-cell ${entry.kind}`}>
                              <span>{entryIcon(entry)}</span>
                              <div>
                                <strong>{entry.name}</strong>
                                {entry.hidden && <em>隐藏项目</em>}
                              </div>
                              {entry.kind === "directory" && (
                                <button
                                  className="file-open-button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void loadDirectory(entry.path);
                                  }}
                                >
                                  打开
                                </button>
                              )}
                            </div>
                          </td>
                          <td>{bytes(entry.sizeBytes)}</td>
                          <td>{kindLabel(entry.kind)}</td>
                          <td>{compactDate(entry.modifiedAt)}</td>
                        </tr>
                      );
                    })}
                    {visibleEntries.length === 0 && (
                      <tr><td className="empty-table" colSpan={5}>{search ? "没有匹配的项目" : "这个文件夹是空的"}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <footer className="finder-selection-bar">
                <span>
                  {selectedEntries.length
                    ? `已选择 ${selectedEntries.length} 个项目 · ${bytes(selectedEntries.reduce((sum, item) => sum + item.sizeBytes, 0))}`
                    : "单击选择，双击打开文件夹"}
                </span>
                <button
                  className="danger-button"
                  disabled={selectedEntries.length === 0}
                  onClick={() => setDeleteEntries(selectedEntries)}
                >
                  <Trash2 size={15} />
                  删除所选
                </button>
              </footer>
            </div>

            <aside className="size-tree-panel">
              <div className="size-tree-head">
                <div>
                  <span className="eyebrow">空间占用</span>
                  <h3>当前目录分支</h3>
                </div>
                <strong>{bytes(listing.totalBytes)}</strong>
              </div>
              <div className="size-tree-root">
                <span><FolderOpen size={18} fill="currentColor" /></span>
                <div>
                  <strong>{pathName(listing.path)}</strong>
                  <em>{listing.entries.length} 个直接子项目</em>
                </div>
              </div>
              <div className="size-tree-branches">
                {sizeEntries.map((entry) => {
                  const width = maxSize > 0 ? Math.max(2, (entry.sizeBytes / maxSize) * 100) : 0;
                  return (
                    <button
                      key={entry.path}
                      className={selected.has(entry.path) ? "selected" : ""}
                      onClick={() => toggleSelected(entry)}
                      onDoubleClick={() => entry.kind === "directory" && void loadDirectory(entry.path)}
                    >
                      <span className="branch-line" />
                      <span className={`branch-icon ${entry.kind}`}>{entryIcon(entry)}</span>
                      <span className="branch-info">
                        <span><strong>{entry.name}</strong><em>{bytes(entry.sizeBytes)}</em></span>
                        <span className="branch-size-track"><i style={{ width: `${width}%` }} /></span>
                      </span>
                    </button>
                  );
                })}
                {sizeEntries.length === 0 && <p className="size-tree-empty">暂无子项目</p>}
              </div>
              <p className="size-tree-note">大小来自远程 SSH 的 du 查询；结果缓存 15 分钟，点击顶部刷新按钮才会强制重新查询。</p>
            </aside>
          </div>
        </div>
      </div>

      {loading && (
        <div className="file-loading-overlay">
          <LoaderCircle className="spin" size={22} />
          <span>正在通过 SSH 查询并统计目录大小。大型目录可能需要数分钟，请保持页面打开…</span>
        </div>
      )}

      {deleteEntries.length > 0 && (
        <DeleteDialog
          entries={deleteEntries}
          onClose={() => setDeleteEntries([])}
          onDeleted={finishDelete}
        />
      )}
    </section>
  );
}
