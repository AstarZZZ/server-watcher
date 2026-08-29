import {
  Activity,
  Boxes,
  Clock3,
  Cpu,
  Database,
  Filter,
  FolderOpen,
  Gauge,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MemoryStick,
  Moon,
  Power,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  Signal,
  Square,
  Sun,
  TerminalSquare,
  Thermometer,
  Users
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  getAutostart,
  getLogs,
  getSnapshot,
  login,
  logout,
  me as fetchMe,
  refreshSnapshot,
  scanStorage,
  sendSignal,
  systemdAction
} from "./api";
import { bytes, compactDate, duration, percent } from "./format";
import RemoteFileManager from "./RemoteFileManager";
import TerminalPane from "./TerminalPane";
import type {
  AutostartItem,
  GpuInfo,
  Me,
  ProcessInfo,
  SystemSnapshot,
  UserUsage,
  WatcherEvent
} from "./types";

type Page =
  | "overview"
  | "gpus"
  | "processes"
  | "users"
  | "storage"
  | "files"
  | "logs"
  | "terminal"
  | "autostart";

type ThemeMode = "dark" | "light";
type StorageItem = SystemSnapshot["storage"][number];
type FilesystemItem = SystemSnapshot["filesystems"][number];

interface PendingAction {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  allowSudo?: boolean;
  run: (password: string, sudo: boolean) => Promise<void>;
}

const navItems: Array<{
  id: Page;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "gpus", label: "GPU", icon: Gauge },
  { id: "processes", label: "进程", icon: Activity },
  { id: "users", label: "用户", icon: Users },
  { id: "storage", label: "存储", icon: HardDrive },
  { id: "files", label: "远程文件", icon: FolderOpen },
  { id: "logs", label: "日志", icon: ListChecks },
  { id: "terminal", label: "终端", icon: TerminalSquare },
  { id: "autostart", label: "自启动", icon: Power }
];

const refreshIntervalOptions = [1000, 2000, 5000, 10000, 30000, 60000] as const;
const defaultRefreshIntervalMs = 2000;
const storageChartColors = [
  "#0891b2",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#2563eb",
  "#be123c"
];

function normalizeRefreshInterval(value: number): number {
  if (!Number.isFinite(value)) return defaultRefreshIntervalMs;
  return Math.min(60000, Math.max(1000, Math.round(value / 1000) * 1000));
}

function getStoredRefreshInterval(): number {
  const stored = window.localStorage.getItem("server-watcher.refreshIntervalMs");
  return normalizeRefreshInterval(Number(stored ?? defaultRefreshIntervalMs));
}

function getStoredTheme(): ThemeMode {
  const stored = window.localStorage.getItem("server-watcher.theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

function mountContainsPath(mount: string, targetPath: string): boolean {
  if (mount === "/") return targetPath.startsWith("/");
  const cleanMount = mount.replace(/\/+$/, "");
  return targetPath === cleanMount || targetPath.startsWith(`${cleanMount}/`);
}

function findStorageFilesystem(snapshot: SystemSnapshot | null): FilesystemItem | undefined {
  const filesystems = snapshot?.filesystems ?? [];
  const samplePath = snapshot?.storage.find((item) => item.path)?.path ?? "/home";
  return (
    filesystems
      .filter((filesystem) => mountContainsPath(filesystem.mount, samplePath))
      .sort((left, right) => right.mount.length - left.mount.length)[0] ??
    filesystems.find((item) => item.mount === "/") ??
    filesystems[0]
  );
}

function successfulStorageItems(storage: StorageItem[]): StorageItem[] {
  return storage
    .filter((item) => item.status === "ok" && item.bytes > 0)
    .sort((left, right) => right.bytes - left.bytes);
}

function colorForIndex(index: number): string {
  return storageChartColors[index % storageChartColors.length];
}

function buildConicGradient(segments: Array<{ color: string; percent: number }>): string {
  if (segments.length === 0) return "conic-gradient(var(--progress-track) 0% 100%)";
  let start = 0;
  const stops = segments.map((segment) => {
    const end = start + segment.percent;
    const stop = `${segment.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
    start = end;
    return stop;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

function ProgressBar({
  value,
  tone = "normal"
}: {
  value: number | null | undefined;
  tone?: "normal" | "warn" | "danger";
}) {
  const width = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className={`progress ${tone}`}>
      <span style={{ width: `${width}%` }} />
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "cyan"
}: {
  label: string;
  value: string;
  sub: string;
  icon: typeof Cpu;
  tone?: "cyan" | "green" | "amber" | "red";
}) {
  return (
    <article className={`stat-card ${tone}`}>
      <div className="stat-icon">
        <Icon size={20} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{sub}</small>
      </div>
    </article>
  );
}

function StorageBarChart({ storage }: { storage: StorageItem[] }) {
  const rows = successfulStorageItems(storage).slice(0, 10);
  const maxBytes = rows[0]?.bytes ?? 0;
  const totalBytes = rows.reduce((sum, item) => sum + item.bytes, 0);

  return (
    <article className="chart-panel storage-bar-panel">
      <div className="chart-head">
        <div>
          <h3>用户空间排行</h3>
          <p>按最近一次扫描的目录占用排序。</p>
        </div>
        <strong>{bytes(totalBytes)}</strong>
      </div>
      {rows.length === 0 ? (
        <div className="empty-panel compact">还没有可绘制的存储扫描结果</div>
      ) : (
        <div className="storage-bars">
          {rows.map((item, index) => {
            const width = maxBytes > 0 ? Math.max(2, (item.bytes / maxBytes) * 100) : 0;
            return (
              <div className="storage-bar-row" key={`${item.user}-${item.path}`}>
                <div className="storage-bar-meta">
                  <strong>{item.user}</strong>
                  <span>{bytes(item.bytes)}</span>
                </div>
                <div className="storage-bar-track" title={`${item.path} · ${bytes(item.bytes)}`}>
                  <span
                    style={{
                      width: `${width}%`,
                      background: colorForIndex(index)
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function StoragePieChart({
  storage,
  filesystem
}: {
  storage: StorageItem[];
  filesystem: FilesystemItem | undefined;
}) {
  const sortedStorage = successfulStorageItems(storage);
  const scannedBytes = sortedStorage.reduce((sum, item) => sum + item.bytes, 0);
  const userSegments = sortedStorage.slice(0, 5).map((item, index) => ({
    label: item.user,
    value: item.bytes,
    color: colorForIndex(index)
  }));
  const otherUserBytes = sortedStorage.slice(5).reduce((sum, item) => sum + item.bytes, 0);
  if (otherUserBytes > 0) {
    userSegments.push({
      label: "其他用户",
      value: otherUserBytes,
      color: colorForIndex(5)
    });
  }

  const untrackedBytes = filesystem
    ? Math.max(0, filesystem.usedBytes - scannedBytes)
    : 0;
  const freeBytes = filesystem ? Math.max(0, filesystem.availableBytes) : 0;
  const baseSegments = [
    ...userSegments,
    ...(untrackedBytes > 0
      ? [{ label: "系统/未扫描", value: untrackedBytes, color: "#64748b" }]
      : []),
    ...(freeBytes > 0
      ? [{ label: "剩余空间", value: freeBytes, color: "#94a3b8" }]
      : [])
  ].filter((segment) => segment.value > 0);
  const baseBytes = baseSegments.reduce((sum, segment) => sum + segment.value, 0);
  const totalBytes = Math.max(filesystem?.totalBytes ?? 0, baseBytes);
  const reservedBytes = Math.max(0, totalBytes - baseBytes);
  const segments = [
    ...baseSegments,
    ...(reservedBytes > 0
      ? [{ label: "保留空间", value: reservedBytes, color: "#cbd5e1" }]
      : [])
  ];
  const gradientSegments = segments.map((segment) => ({
    color: segment.color,
    percent: totalBytes > 0 ? (segment.value / totalBytes) * 100 : 0
  }));

  return (
    <article className="chart-panel storage-pie-panel">
      <div className="chart-head">
        <div>
          <h3>空间构成</h3>
          <p>{filesystem ? `${filesystem.mount} · 含剩余空间` : "扫描目录 · 含剩余空间"}</p>
        </div>
        <strong>{filesystem ? percent(filesystem.usedPercent) : "--"}</strong>
      </div>
      {segments.length === 0 || totalBytes <= 0 ? (
        <div className="empty-panel compact">还没有可绘制的磁盘空间数据</div>
      ) : (
        <div className="donut-layout">
          <div
            className="donut-chart"
            style={{ background: buildConicGradient(gradientSegments) }}
            role="img"
            aria-label="用户存储空间构成饼图"
          >
            <div className="donut-hole">
              <span>总空间</span>
              <strong>{bytes(totalBytes)}</strong>
            </div>
          </div>
          <div className="pie-legend">
            {segments.map((segment) => (
              <div className="pie-legend-row" key={segment.label}>
                <span className="legend-dot" style={{ background: segment.color }} />
                <strong>{segment.label}</strong>
                <span>{bytes(segment.value)}</span>
                <em>{percent(totalBytes > 0 ? (segment.value / totalBytes) * 100 : null)}</em>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function LoginScreen({
  onLogin
}: {
  onLogin: (user: Me, password: string) => void;
}) {
  const [host, setHost] = useState(
    () => window.localStorage.getItem("server-watcher.sshHost") ?? "127.0.0.1"
  );
  const [port, setPort] = useState(
    () => window.localStorage.getItem("server-watcher.sshPort") ?? "22"
  );
  const [username, setUsername] = useState(
    () => window.localStorage.getItem("server-watcher.sshUsername") ?? ""
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const user = await login(host, Number(port), username, password);
      window.localStorage.setItem("server-watcher.sshHost", user.host);
      window.localStorage.setItem("server-watcher.sshPort", String(user.port));
      window.localStorage.setItem("server-watcher.sshUsername", user.username);
      onLogin(user, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-mark">
          <Server size={26} />
        </div>
        <h1>Server Watcher</h1>
        <p>连接你的 SSH 服务器。文件权限由远程 Linux 账户决定，密码不会被保存。</p>
        <div className="login-target-row">
          <label>
            SSH 主机
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="服务器 IP 或域名"
            />
          </label>
          <label>
            端口
            <input
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              placeholder="22"
            />
          </label>
        </div>
        <label>
          用户名
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            placeholder="SSH 用户名"
          />
        </label>
        <label>
          SSH 密码
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="password"
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" disabled={loading || !username || !password}>
          <ShieldAlert size={16} />
          {loading ? "正在连接" : "登录 SSH 服务器"}
        </button>
      </form>
    </main>
  );
}

function GpuCard({ gpu }: { gpu: GpuInfo }) {
  const memoryPercent =
    gpu.memoryTotalBytes > 0
      ? (gpu.memoryUsedBytes / gpu.memoryTotalBytes) * 100
      : null;
  return (
    <article className="gpu-card">
      <div className="gpu-card-head">
        <div>
          <span>GPU {gpu.index}</span>
          <h3>{gpu.name}</h3>
        </div>
        <div className="gpu-temp">
          <Thermometer size={15} />
          {gpu.temperatureC ?? "--"} C
        </div>
      </div>
      <div className="gpu-metrics">
        <div>
          <span>GPU</span>
          <strong>{percent(gpu.utilizationGpu)}</strong>
          <ProgressBar value={gpu.utilizationGpu} />
        </div>
        <div>
          <span>显存</span>
          <strong>{bytes(gpu.memoryUsedBytes)} / {bytes(gpu.memoryTotalBytes)}</strong>
          <ProgressBar value={memoryPercent} tone="warn" />
        </div>
      </div>
      <div className="gpu-meta">
        <span>功耗 {gpu.powerDrawW ?? "--"} / {gpu.powerLimitW ?? "--"} W</span>
        <span>风扇 {percent(gpu.fanSpeedPercent)}</span>
        <span>进程 {gpu.processes.length}</span>
      </div>
      <div className="mini-processes">
        {gpu.processes.length === 0 ? (
          <span className="empty-line">暂无 GPU 进程</span>
        ) : (
          gpu.processes.slice(0, 4).map((process) => (
            <div key={`${gpu.uuid}-${process.pid}`}>
              <span>{process.user}</span>
              <strong>{process.pid}</strong>
              <em>{bytes(process.gpuMemoryBytes)}</em>
            </div>
          ))
        )}
      </div>
    </article>
  );
}

function ProcessTable({
  processes,
  onSignal
}: {
  processes: ProcessInfo[];
  onSignal: (process: ProcessInfo, signal: "TERM" | "KILL") => void;
}) {
  return (
    <div className="table-frame">
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>PID</th>
            <th>命令</th>
            <th>GPU</th>
            <th>显存</th>
            <th>CPU</th>
            <th>内存</th>
            <th>RSS</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {processes.map((process) => (
            <tr key={process.pid}>
              <td>{process.user}</td>
              <td className="mono">{process.pid}</td>
              <td>
                <div className="command-cell" title={process.command}>
                  <strong>{process.name}</strong>
                  <span>{process.command}</span>
                </div>
              </td>
              <td>{process.gpuIndexes.length ? process.gpuIndexes.join(", ") : "--"}</td>
              <td>{bytes(process.gpuMemoryBytes)}</td>
              <td>{percent(process.cpuPercent)}</td>
              <td>{percent(process.memoryPercent)}</td>
              <td>{bytes(process.rssBytes)}</td>
              <td>
                <div className="row-actions">
                  <button onClick={() => onSignal(process, "TERM")} title="发送 SIGTERM">
                    <Square size={14} />
                  </button>
                  <button className="danger" onClick={() => onSignal(process, "KILL")} title="发送 SIGKILL">
                    <Power size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {processes.length === 0 && (
            <tr>
              <td colSpan={9} className="empty-table">没有匹配的进程</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function UserTable({ users }: { users: UserUsage[] }) {
  return (
    <div className="table-frame">
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>进程</th>
            <th>GPU</th>
            <th>GPU 显存</th>
            <th>CPU 合计</th>
            <th>内存 RSS</th>
            <th>存储</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.user}>
              <td>{user.user}</td>
              <td>{user.processCount}</td>
              <td>{user.gpuIndexes.length ? user.gpuIndexes.join(", ") : "--"}</td>
              <td>{bytes(user.gpuMemoryBytes)}</td>
              <td>{percent(user.cpuPercent)}</td>
              <td>{bytes(user.rssBytes)}</td>
              <td>{user.storageBytes === undefined ? "--" : bytes(user.storageBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PasswordActionModal({
  action,
  onClose,
  onDone
}: {
  action: PendingAction | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [sudo, setSudo] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!action) return null;
  const currentAction = action;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await currentAction.run(password, sudo);
      onDone("操作已提交");
      setPassword("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal-card" onSubmit={submit}>
        <h3>{currentAction.title}</h3>
        <p>{currentAction.description}</p>
        <label>
          SSH 密码
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {currentAction.allowSudo && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={sudo}
              onChange={(event) => setSudo(event.target.checked)}
            />
            使用 sudo 执行
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button
            className={currentAction.danger ? "danger-button" : "primary-button"}
            disabled={!password || loading}
          >
            {currentAction.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function AutostartPage({
  items,
  onRefresh,
  onSystemdAction
}: {
  items: AutostartItem[];
  onRefresh: () => void;
  onSystemdAction: (
    service: string,
    action: "start" | "stop" | "restart" | "enable" | "disable"
  ) => void;
}) {
  return (
    <section>
      <div className="section-head">
        <div>
          <h2>系统自启动项目</h2>
          <p>汇总 systemd、cron、PM2、Docker 和 Supervisor。</p>
        </div>
        <button className="secondary-button" onClick={onRefresh}>
          <RefreshCw size={16} />
          刷新
        </button>
      </div>
      <div className="table-frame">
        <table>
          <thead>
            <tr>
              <th>来源</th>
              <th>名称</th>
              <th>状态</th>
              <th>描述/命令</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={`${item.source}-${item.name}-${index}`}>
                <td><span className={`source-pill ${item.source}`}>{item.source}</span></td>
                <td className="mono">{item.name}</td>
                <td>{item.state}</td>
                <td>
                  <div className="command-cell">
                    <strong>{item.description ?? item.user ?? "--"}</strong>
                    <span>{item.command ?? item.raw ?? ""}</span>
                  </div>
                </td>
                <td>
                  {item.source === "systemd" ? (
                    <div className="row-actions wide">
                      <button onClick={() => onSystemdAction(item.name, "restart")}>restart</button>
                      <button onClick={() => onSystemdAction(item.name, "stop")}>stop</button>
                      <button onClick={() => onSystemdAction(item.name, "enable")}>enable</button>
                      <button className="danger" onClick={() => onSystemdAction(item.name, "disable")}>disable</button>
                    </div>
                  ) : (
                    <span className="muted">只读</span>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-table">没有读取到自启动项目</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function App() {
  const [user, setUser] = useState<Me | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [page, setPage] = useState<Page>("overview");
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [logs, setLogs] = useState<WatcherEvent[]>([]);
  const [autostart, setAutostart] = useState<AutostartItem[]>([]);
  const [toast, setToast] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [sshPassword, setSshPassword] = useState("");
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(getStoredRefreshInterval);
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const [filters, setFilters] = useState({
    user: "",
    process: "",
    gpu: "",
    cpu: ""
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("server-watcher.theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(
      "server-watcher.refreshIntervalMs",
      String(refreshIntervalMs)
    );
  }, [refreshIntervalMs]);

  useEffect(() => {
    fetchMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setCheckingAuth(false));
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    let socket: WebSocket | null = null;
    let closed = false;

    getSnapshot().then(setSnapshot).catch((error) => setToast(error.message));
    socket = new WebSocket(wsUrl(`/ws/live?intervalMs=${refreshIntervalMs}`));
    socket.onopen = () => {
      socket?.send(JSON.stringify({ type: "interval", intervalMs: refreshIntervalMs }));
    };
    socket.onmessage = (message) => {
      const payload = JSON.parse(message.data) as {
        type: string;
        snapshot?: SystemSnapshot;
      };
      if (payload.type === "snapshot" && payload.snapshot) {
        setSnapshot(payload.snapshot);
      }
    };
    socket.onclose = () => {
      if (!closed) setToast("实时连接已断开，页面仍可手动刷新。");
    };

    return () => {
      closed = true;
      socket?.close();
    };
  }, [refreshIntervalMs, user]);

  useEffect(() => {
    if (!user) return;
    if (page === "logs") {
      getLogs(300).then((body) => setLogs(body.events)).catch((error) => setToast(error.message));
    }
    if (page === "autostart") {
      getAutostart().then((body) => setAutostart(body.items)).catch((error) => setToast(error.message));
    }
  }, [page, user]);

  const filteredProcesses = useMemo(() => {
    const source = snapshot?.processes ?? [];
    const minCpu = filters.cpu ? Number(filters.cpu) : null;
    return source.filter((process) => {
      if (filters.user && !process.user.toLowerCase().includes(filters.user.toLowerCase())) return false;
      if (
        filters.process &&
        !`${process.name} ${process.command}`.toLowerCase().includes(filters.process.toLowerCase())
      ) return false;
      if (filters.gpu && !process.gpuIndexes.map(String).includes(filters.gpu)) return false;
      if (minCpu !== null && Number.isFinite(minCpu) && (process.cpuPercent ?? 0) < minCpu) return false;
      return true;
    });
  }, [filters, snapshot]);

  if (checkingAuth) {
    return <div className="boot-screen">Loading Server Watcher...</div>;
  }

  if (!user) {
    return (
      <LoginScreen
        onLogin={(nextUser, password) => {
          setUser(nextUser);
          setSshPassword(password);
          setPage("files");
        }}
      />
    );
  }

  const currentUser = user;
  const gpuTotal = snapshot?.gpus.reduce((sum, gpu) => sum + gpu.memoryTotalBytes, 0) ?? 0;
  const gpuUsed = snapshot?.gpus.reduce((sum, gpu) => sum + gpu.memoryUsedBytes, 0) ?? 0;
  const rootFs = snapshot?.filesystems.find((item) => item.mount === "/") ?? snapshot?.filesystems[0];
  const storageFs = findStorageFilesystem(snapshot);
  const topLogs = logs.length ? logs.slice(0, 7) : [];
  const refreshLabel = `${refreshIntervalMs / 1000} 秒`;

  function doSignal(process: ProcessInfo, signal: "TERM" | "KILL") {
    setPendingAction({
      title: signal === "KILL" ? "强制结束进程" : "结束进程",
      description: `${signal} 将发送给 PID ${process.pid} (${process.name})。系统会按 ${currentUser.username} 的 SSH 权限执行。`,
      confirmLabel: signal === "KILL" ? "发送 SIGKILL" : "发送 SIGTERM",
      danger: signal === "KILL",
      allowSudo: true,
      run: async (password, sudo) => {
        const result = await sendSignal(process.pid, signal, password, sudo);
        setToast(result.stderr || result.stdout || "操作完成");
        setSnapshot(await refreshSnapshot());
      }
    });
  }

  function doSystemdAction(
    service: string,
    action: "start" | "stop" | "restart" | "enable" | "disable"
  ) {
    setPendingAction({
      title: `systemctl ${action}`,
      description: `即将通过 sudo 执行 systemctl ${action} ${service}。`,
      confirmLabel: "执行",
      danger: ["stop", "disable"].includes(action),
      run: async (password) => {
        const result = await systemdAction(service, action, password);
        setToast(result.stderr || result.stdout || "操作完成");
        const body = await getAutostart();
        setAutostart(body.items);
      }
    });
  }

  function doStorageScan() {
    setPendingAction({
      title: "手动扫描存储",
      description: "会运行 du 统计配置目录下的用户空间占用，大目录可能需要较长时间。",
      confirmLabel: "开始扫描",
      run: async (password) => {
        const body = await scanStorage(password);
        setSnapshot((current) =>
          current ? { ...current, storage: body.storage } : current
        );
        setToast("存储扫描完成");
      }
    });
  }

  async function doLogout() {
    await logout().catch(() => undefined);
    setUser(null);
    setSnapshot(null);
    setSshPassword("");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark small">
            <Server size={20} />
          </div>
          <div>
            <strong>Server Watcher</strong>
            <span>{snapshot?.hostname ?? "server"}</span>
          </div>
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={page === item.id ? "active" : ""}
                onClick={() => setPage(item.id)}
              >
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span>{user.username}</span>
          <button onClick={doLogout} title="退出登录">
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{navItems.find((item) => item.id === page)?.label}</h1>
            <span>
              {page === "files"
                ? `${user.username}@${user.host}:${user.port} · 仅限账户主目录`
                : snapshot
                ? `更新 ${compactDate(snapshot.timestamp)} · ${snapshot.collectionReason} · 运行 ${duration(snapshot.uptimeSeconds)}`
                : "等待采集"}
            </span>
          </div>
          <div className="topbar-actions">
            {page !== "files" && (
              <>
                <label className="interval-control" title="实时刷新间隔">
                  <Clock3 size={15} />
                  <span>刷新</span>
                  <select
                    aria-label="实时刷新间隔"
                    value={refreshIntervalMs}
                    onChange={(event) =>
                      setRefreshIntervalMs(normalizeRefreshInterval(Number(event.target.value)))
                    }
                  >
                    {refreshIntervalOptions.map((interval) => (
                      <option value={interval} key={interval}>
                        {interval / 1000} 秒
                      </option>
                    ))}
                  </select>
                </label>
                <span className={snapshot?.activeClients ? "status-chip live" : "status-chip"}>
                  <Signal size={14} />
                  {snapshot?.activeClients ?? 0} 在线
                </span>
              </>
            )}
            <button
              className="icon-button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {page !== "files" && (
              <button
                className="secondary-button"
                onClick={() => refreshSnapshot().then(setSnapshot).catch((error) => setToast(error.message))}
              >
                <RefreshCw size={16} />
                刷新
              </button>
            )}
          </div>
        </header>

        {toast && (
          <div className="toast" onClick={() => setToast("")}>
            {toast}
          </div>
        )}

        {page !== "files" && snapshot?.warnings.map((warning) => (
          <div className="warning" key={warning}>
            <ShieldAlert size={16} />
            {warning}
          </div>
        ))}

        {page === "overview" && (
          <section className="dashboard-grid">
            <div className="stat-grid">
              <StatCard
                icon={Cpu}
                label="CPU"
                value={percent(snapshot?.cpu.usagePercent)}
                sub={`${snapshot?.cpu.cores ?? "--"} cores · load ${snapshot?.cpu.loadAverage[0]?.toFixed(2) ?? "--"}`}
              />
              <StatCard
                icon={MemoryStick}
                label="内存"
                value={percent(snapshot?.memory.usedPercent)}
                sub={`${bytes(snapshot?.memory.usedBytes)} / ${bytes(snapshot?.memory.totalBytes)}`}
                tone="green"
              />
              <StatCard
                icon={Boxes}
                label="GPU 显存"
                value={gpuTotal ? percent((gpuUsed / gpuTotal) * 100) : "--"}
                sub={`${bytes(gpuUsed)} / ${bytes(gpuTotal)}`}
                tone="amber"
              />
              <StatCard
                icon={Database}
                label="根分区"
                value={percent(rootFs?.usedPercent)}
                sub={rootFs ? `${bytes(rootFs.usedBytes)} / ${bytes(rootFs.totalBytes)}` : "--"}
                tone="red"
              />
            </div>

            <div className="content-grid two">
              <section>
                <div className="section-head">
                  <div>
                    <h2>GPU 实时状态</h2>
                    <p>有人访问时按顶部间隔刷新（当前 {refreshLabel}）；无人访问时降级到每小时快照。</p>
                  </div>
                </div>
                <div className="gpu-grid">
                  {(snapshot?.gpus ?? []).map((gpu) => <GpuCard gpu={gpu} key={gpu.uuid || gpu.index} />)}
                  {snapshot?.gpus.length === 0 && <div className="empty-panel">没有读取到 GPU</div>}
                </div>
              </section>
              <section>
                <div className="section-head">
                  <div>
                    <h2>用户占用</h2>
                    <p>按 GPU 显存和 CPU 聚合。</p>
                  </div>
                </div>
                <UserTable users={(snapshot?.users ?? []).slice(0, 8)} />
              </section>
            </div>

            <section>
              <div className="section-head">
                <div>
                  <h2>高占用进程</h2>
                  <p>优先展示 GPU 显存和 CPU 占用较高的进程。</p>
                </div>
              </div>
              <ProcessTable processes={filteredProcesses.slice(0, 12)} onSignal={doSignal} />
            </section>
          </section>
        )}

        {page === "gpus" && (
          <section>
            <div className="gpu-grid wide">
              {(snapshot?.gpus ?? []).map((gpu) => <GpuCard gpu={gpu} key={gpu.uuid || gpu.index} />)}
            </div>
          </section>
        )}

        {page === "processes" && (
          <section>
            <div className="filter-bar">
              <span><Filter size={16} />筛选</span>
              <label><Users size={15} /><input placeholder="用户" value={filters.user} onChange={(event) => setFilters({ ...filters, user: event.target.value })} /></label>
              <label><Search size={15} /><input placeholder="进程/命令" value={filters.process} onChange={(event) => setFilters({ ...filters, process: event.target.value })} /></label>
              <label><Gauge size={15} /><input placeholder="GPU 编号" value={filters.gpu} onChange={(event) => setFilters({ ...filters, gpu: event.target.value })} /></label>
              <label><Cpu size={15} /><input placeholder="CPU >=" value={filters.cpu} onChange={(event) => setFilters({ ...filters, cpu: event.target.value })} /></label>
            </div>
            <ProcessTable processes={filteredProcesses} onSignal={doSignal} />
          </section>
        )}

        {page === "users" && <UserTable users={snapshot?.users ?? []} />}

        {page === "storage" && (
          <section>
            <div className="section-head">
              <div>
                <h2>用户存储空间</h2>
                <p>默认每天凌晨 2 点扫描，可按需手动触发。</p>
              </div>
              <button className="secondary-button" onClick={doStorageScan}>
                <HardDrive size={16} />
                手动扫描
              </button>
            </div>
            <div className="storage-visual-grid">
              <StorageBarChart storage={snapshot?.storage ?? []} />
              <StoragePieChart storage={snapshot?.storage ?? []} filesystem={storageFs} />
            </div>
            <div className="table-frame">
              <table>
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>路径</th>
                    <th>占用</th>
                    <th>扫描时间</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.storage ?? []).map((item) => (
                    <tr key={`${item.user}-${item.path}`}>
                      <td>{item.user}</td>
                      <td className="mono">{item.path}</td>
                      <td>{bytes(item.bytes)}</td>
                      <td>{compactDate(item.scannedAt)}</td>
                      <td>{item.status === "ok" ? "正常" : item.error}</td>
                    </tr>
                  ))}
                  {snapshot?.storage.length === 0 && (
                    <tr>
                      <td colSpan={5} className="empty-table">还没有存储扫描结果</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {page === "files" && (
          <RemoteFileManager
            user={user}
            password={sshPassword}
            onPasswordChange={setSshPassword}
            onToast={setToast}
          />
        )}

        {page === "logs" && (
          <section>
            <div className="section-head">
              <div>
                <h2>审计日志</h2>
                <p>记录登录、终端、进程操作、采集和存储扫描。</p>
              </div>
              <button className="secondary-button" onClick={() => getLogs(300).then((body) => setLogs(body.events))}>
                <RefreshCw size={16} />
                刷新日志
              </button>
            </div>
            <div className="log-list">
              {(topLogs.length ? topLogs : logs).map((event) => (
                <article key={event.id}>
                  <span>{compactDate(event.timestamp)}</span>
                  <strong>{event.type}</strong>
                  <em>{event.actor ?? "system"}</em>
                  <p>{event.message}</p>
                </article>
              ))}
              {logs.length === 0 && <div className="empty-panel">暂无日志</div>}
            </div>
          </section>
        )}

        {page === "terminal" && <TerminalPane username={user.username} theme={theme} />}

        {page === "autostart" && (
          <AutostartPage
            items={autostart}
            onRefresh={() => getAutostart().then((body) => setAutostart(body.items))}
            onSystemdAction={doSystemdAction}
          />
        )}
      </main>

      <PasswordActionModal
        action={pendingAction}
        onClose={() => setPendingAction(null)}
        onDone={setToast}
      />
    </div>
  );
}
