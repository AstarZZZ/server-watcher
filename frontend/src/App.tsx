import {
  Activity,
  Boxes,
  Cable,
  Cpu,
  Database,
  Filter,
  Gauge,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MemoryStick,
  PlayCircle,
  Power,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  Signal,
  Square,
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
  | "logs"
  | "terminal"
  | "autostart";

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
  { id: "logs", label: "日志", icon: ListChecks },
  { id: "terminal", label: "终端", icon: TerminalSquare },
  { id: "autostart", label: "自启动", icon: Power }
];

function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
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

function LoginScreen({
  onLogin
}: {
  onLogin: (user: Me) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      onLogin(await login(username, password));
      setPassword("");
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
        <p>使用服务器 SSH 账号登录。权限由 Linux 用户、用户组和 sudoers 决定。</p>
        <label>
          用户名
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            placeholder="zhaojunzhe"
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
          {loading ? "验证中" : "登录看板"}
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
  const [filters, setFilters] = useState({
    user: "",
    process: "",
    gpu: "",
    cpu: ""
  });

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
    socket = new WebSocket(wsUrl("/ws/live"));
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
  }, [user]);

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
    return <LoginScreen onLogin={setUser} />;
  }

  const currentUser = user;
  const gpuTotal = snapshot?.gpus.reduce((sum, gpu) => sum + gpu.memoryTotalBytes, 0) ?? 0;
  const gpuUsed = snapshot?.gpus.reduce((sum, gpu) => sum + gpu.memoryUsedBytes, 0) ?? 0;
  const rootFs = snapshot?.filesystems.find((item) => item.mount === "/") ?? snapshot?.filesystems[0];
  const topLogs = logs.length ? logs.slice(0, 7) : [];

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
              {snapshot
                ? `更新 ${compactDate(snapshot.timestamp)} · ${snapshot.collectionReason} · 运行 ${duration(snapshot.uptimeSeconds)}`
                : "等待采集"}
            </span>
          </div>
          <div className="topbar-actions">
            <span className={snapshot?.activeClients ? "status-chip live" : "status-chip"}>
              <Signal size={14} />
              {snapshot?.activeClients ?? 0} 在线
            </span>
            <button
              className="secondary-button"
              onClick={() => refreshSnapshot().then(setSnapshot).catch((error) => setToast(error.message))}
            >
              <RefreshCw size={16} />
              刷新
            </button>
          </div>
        </header>

        {toast && (
          <div className="toast" onClick={() => setToast("")}>
            {toast}
          </div>
        )}

        {snapshot?.warnings.map((warning) => (
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
                    <p>有人访问时每 2 秒刷新；无人访问时降级到每小时快照。</p>
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

        {page === "terminal" && <TerminalPane username={user.username} />}

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
