import fs from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  isValidSystemdAction,
  isValidSystemdService,
  listAutostartItems
} from "./autostart.js";
import {
  authenticateSsh,
  clearSessionCookie,
  connectSsh,
  createSession,
  destroySession,
  execSsh,
  getSession,
  parseCookies,
  writeSessionCookie
} from "./auth.js";
import { Collector } from "./collector.js";
import { config } from "./config.js";
import { readEvents, recordEvent } from "./logger.js";
import type { SystemSnapshot } from "./types.js";

interface JsonBody {
  [key: string]: unknown;
}

const liveClients = new Set<WebSocket>();
const liveClientIntervals = new Map<WebSocket, { intervalMs: number; lastSentAt: number }>();
const terminalClients = new Set<WebSocket>();
const defaultLiveIntervalMs = 2000;

function normalizeLiveInterval(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultLiveIntervalMs;
  return Math.min(60_000, Math.max(2000, Math.round(parsed / 1000) * 1000));
}

const collector = new Collector(
  () => liveClients.size + terminalClients.size,
  () => {
    if (liveClientIntervals.size > 0) {
      return Math.min(
        ...Array.from(liveClientIntervals.values()).map((item) => item.intervalMs)
      );
    }
    return terminalClients.size > 0 ? defaultLiveIntervalMs : null;
  }
);

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string
): void {
  sendJson(res, statusCode, { error: message });
}

async function readJson(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const size = chunks.reduce((sum, item) => sum + item.length, 0);
    if (size > 1024 * 1024) throw new Error("请求体过大");
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonBody;
}

function getUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

async function requireSession(
  req: IncomingMessage,
  res: ServerResponse
) {
  const session = getSession(req);
  if (!session) {
    sendError(res, 401, "请先登录");
    return null;
  }
  return session;
}

function validateSignal(value: unknown): "TERM" | "KILL" | "INT" | "HUP" {
  const signal = String(value ?? "TERM").toUpperCase();
  if (["TERM", "KILL", "INT", "HUP"].includes(signal)) {
    return signal as "TERM" | "KILL" | "INT" | "HUP";
  }
  throw new Error("不支持的 signal");
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = getUrl(req);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const requested = path.resolve(config.staticDir, `.${pathname}`);
  const staticRoot = path.resolve(config.staticDir);
  if (!requested.startsWith(staticRoot)) {
    sendError(res, 403, "路径不合法");
    return;
  }

  try {
    const stat = await fs.stat(requested);
    if (stat.isFile()) {
      res.writeHead(200, { "content-type": contentType(requested) });
      res.end(await fs.readFile(requested));
      return;
    }
  } catch {
    // Fall through to SPA fallback.
  }

  try {
    const index = path.join(staticRoot, "index.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await fs.readFile(index));
  } catch {
    sendError(res, 404, "前端还没有构建，请先运行 npm run build");
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = getUrl(req);
  const method = req.method ?? "GET";

  if (method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(req);
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const auth = await authenticateSsh(username, password);
    const session = createSession(auth.username, auth.groups);
    writeSessionCookie(res, session);
    await recordEvent("auth.login", "用户登录成功", username, {
      groups: auth.groups,
      remoteAddress: req.socket.remoteAddress
    });
    sendJson(res, 200, {
      username: auth.username,
      groups: auth.groups,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/logout") {
    const token = parseCookies(req).watcher_session;
    const session = getSession(req);
    if (token) destroySession(token);
    clearSessionCookie(res);
    await recordEvent("auth.logout", "用户退出登录", session?.username);
    sendJson(res, 200, { ok: true });
    return;
  }

  const session = await requireSession(req, res);
  if (!session) return;

  if (method === "GET" && url.pathname === "/api/me") {
    sendJson(res, 200, {
      username: session.username,
      groups: session.groups,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/snapshot") {
    const snapshot =
      collector.getSnapshot() ?? (await collector.forceCollect("api"));
    sendJson(res, 200, snapshot);
    return;
  }

  if (method === "POST" && url.pathname === "/api/snapshot/refresh") {
    sendJson(res, 200, await collector.forceCollect("manual"));
    return;
  }

  if (method === "POST" && url.pathname === "/api/storage/scan") {
    const body = await readJson(req);
    const password = String(body.password ?? "");
    if (!password) throw new Error("请重新输入 SSH 密码后再扫描存储");
    const auth = await authenticateSsh(session.username, password);
    const storage = await collector.forceStorageScan();
    await recordEvent("storage.manual_scan", "手动触发存储扫描", auth.username);
    sendJson(res, 200, { storage });
    return;
  }

  if (method === "GET" && url.pathname === "/api/logs") {
    const limit = Number(url.searchParams.get("limit") ?? 200);
    sendJson(res, 200, { events: await readEvents(limit) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/autostart") {
    sendJson(res, 200, { items: await listAutostartItems() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/autostart/systemd/action") {
    const body = await readJson(req);
    const service = String(body.service ?? "");
    const action = String(body.action ?? "");
    const password = String(body.password ?? "");
    if (!isValidSystemdService(service)) throw new Error("service 名称不合法");
    if (!isValidSystemdAction(action)) throw new Error("systemd 操作不合法");
    if (!password) throw new Error("请输入 SSH 密码");
    const command = `sudo -S -p '' systemctl ${action} ${service}`;
    const result = await execSsh(
      session.username,
      password,
      command,
      `${password}\n`
    );
    await recordEvent(
      "systemd.action",
      `${action} ${service}`,
      session.username,
      { code: result.code, stderr: result.stderr.slice(0, 500) }
    );
    sendJson(res, result.code === 0 ? 200 : 400, result);
    return;
  }

  const processSignalMatch = url.pathname.match(
    /^\/api\/process\/(\d+)\/signal$/
  );
  if (method === "POST" && processSignalMatch) {
    const pid = Number(processSignalMatch[1]);
    const body = await readJson(req);
    const password = String(body.password ?? "");
    const signal = validateSignal(body.signal);
    const useSudo = Boolean(body.sudo);
    if (!password) throw new Error("请输入 SSH 密码");
    const command = useSudo
      ? `sudo -S -p '' kill -${signal} ${pid}`
      : `kill -${signal} ${pid}`;
    const result = await execSsh(
      session.username,
      password,
      command,
      useSudo ? `${password}\n` : undefined
    );
    await recordEvent("process.signal", `kill -${signal} ${pid}`, session.username, {
      pid,
      signal,
      sudo: useSudo,
      code: result.code,
      stderr: result.stderr.slice(0, 500)
    });
    sendJson(res, result.code === 0 ? 200 : 400, result);
    return;
  }

  sendError(res, 404, "接口不存在");
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = getUrl(req);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res);
        return;
      }
      await serveStatic(req, res);
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : String(error)
      );
    }
  })();
});

function wsReject(socket: Duplex, status = 401, message = "Unauthorized"): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

const liveWss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });

function sendWs(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function sendSnapshotToClient(
  client: WebSocket,
  snapshot: SystemSnapshot,
  force = false
): void {
  const settings = liveClientIntervals.get(client);
  if (!settings) return;
  const now = Date.now();
  if (!force && now - settings.lastSentAt < settings.intervalMs) return;
  settings.lastSentAt = now;
  sendWs(client, { type: "snapshot", snapshot });
}

function broadcastSnapshot(snapshot: SystemSnapshot): void {
  for (const client of liveClients) {
    sendSnapshotToClient(client, snapshot);
  }
}

collector.on("snapshot", broadcastSnapshot);

liveWss.on("connection", (ws, req) => {
  const session = getSession(req);
  if (!session) {
    ws.close(1008, "unauthorized");
    return;
  }
  const url = getUrl(req);
  const intervalMs = normalizeLiveInterval(url.searchParams.get("intervalMs"));
  liveClients.add(ws);
  liveClientIntervals.set(ws, { intervalMs, lastSentAt: 0 });
  void recordEvent("client.open", "前端实时连接打开", session.username);
  const snapshot = collector.getSnapshot();
  if (snapshot) sendSnapshotToClient(ws, snapshot, true);
  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        intervalMs?: number;
      };
      if (message.type === "interval") {
        const settings = liveClientIntervals.get(ws);
        if (settings) {
          settings.intervalMs = normalizeLiveInterval(message.intervalMs);
        }
      }
    } catch {
      // Ignore malformed live-control messages.
    }
  });
  ws.on("close", () => {
    liveClients.delete(ws);
    liveClientIntervals.delete(ws);
    void recordEvent("client.close", "前端实时连接关闭", session.username);
  });
});

terminalWss.on("connection", (ws, req) => {
  const session = getSession(req);
  if (!session) {
    ws.close(1008, "unauthorized");
    return;
  }
  terminalClients.add(ws);
  let sshClient: Awaited<ReturnType<typeof connectSsh>> | null = null;
  let shell: NodeJS.ReadWriteStream | null = null;

  sendWs(ws, { type: "status", message: "请输入密码以打开 SSH 终端" });

  ws.on("message", (raw) => {
    void (async () => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        password?: string;
        cols?: number;
        rows?: number;
        data?: string;
      };

      if (message.type === "auth") {
        if (sshClient) return;
        try {
          sshClient = await connectSsh(session.username, String(message.password ?? ""));
        } catch (error) {
          sendWs(ws, {
            type: "error",
            message: error instanceof Error ? error.message : String(error)
          });
          ws.close(1008, "ssh auth failed");
          return;
        }
        sshClient.on("close", () => {
          sendWs(ws, { type: "status", message: "SSH 连接已关闭" });
          ws.close();
        });
        await recordEvent("terminal.open", "打开 Web SSH 终端", session.username);
        sshClient.shell(
          {
            term: "xterm-256color",
            cols: Number(message.cols ?? 100),
            rows: Number(message.rows ?? 30)
          },
          (error, stream) => {
            if (error) {
              sendWs(ws, { type: "error", message: error.message });
              ws.close(1011, "shell failed");
              return;
            }
            shell = stream;
            sendWs(ws, { type: "status", message: "SSH 连接成功" });
            stream.on("data", (chunk: Buffer) => {
              sendWs(ws, { type: "data", data: chunk.toString("utf8") });
            });
            stream.stderr?.on("data", (chunk: Buffer) => {
              sendWs(ws, { type: "data", data: chunk.toString("utf8") });
            });
            stream.on("close", () => {
              sendWs(ws, { type: "status", message: "Shell 已关闭" });
              ws.close();
            });
          }
        );
        return;
      }

      if (message.type === "input" && shell && typeof message.data === "string") {
        shell.write(message.data);
        return;
      }

      if (message.type === "resize" && shell) {
        const stream = shell as NodeJS.ReadWriteStream & {
          setWindow?: (rows: number, cols: number, height: number, width: number) => void;
        };
        stream.setWindow?.(
          Number(message.rows ?? 30),
          Number(message.cols ?? 100),
          0,
          0
        );
      }
    })().catch((error) => {
      sendWs(ws, {
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    });
  });

  ws.on("close", () => {
    terminalClients.delete(ws);
    if (shell) shell.end();
    if (sshClient) sshClient.end();
    void recordEvent("terminal.close", "关闭 Web SSH 终端", session.username);
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = getUrl(req);
  if (!getSession(req)) {
    wsReject(socket);
    return;
  }
  if (url.pathname === "/ws/live") {
    liveWss.handleUpgrade(req, socket, head, (ws) => {
      liveWss.emit("connection", ws, req);
    });
    return;
  }
  if (url.pathname === "/ws/terminal") {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit("connection", ws, req);
    });
    return;
  }
  wsReject(socket, 404, "Not Found");
});

collector.start();

server.listen(config.port, config.host, () => {
  console.log(
    `server-watcher listening on http://${config.host}:${config.port} static=${config.staticDir}`
  );
});

process.on("SIGTERM", () => {
  collector.stop();
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  collector.stop();
  server.close(() => process.exit(0));
});
