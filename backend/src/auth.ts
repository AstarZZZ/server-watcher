import crypto from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "ssh2";
import { config } from "./config.js";

export interface SshTarget {
  host: string;
  port: number;
}

export interface Session {
  token: string;
  username: string;
  groups: string[];
  host: string;
  port: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function isSafeUsername(username: string): boolean {
  return /^[a-zA-Z0-9_.@-]{1,64}$/.test(username);
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key) continue;
    cookies[key] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

export function getSession(req: IncomingMessage): Session | null {
  const token = parseCookies(req).watcher_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt < now) {
    sessions.delete(token);
    return null;
  }
  session.lastSeenAt = now;
  return session;
}

export function createSession(
  username: string,
  groups: string[],
  target: SshTarget
): Session {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const session: Session = {
    token,
    username,
    groups,
    host: target.host,
    port: target.port,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + config.sessionHours * 60 * 60 * 1000
  };
  sessions.set(token, session);
  return session;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function writeSessionCookie(res: ServerResponse, session: Session): void {
  const maxAge = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
  const secure = config.secureCookies ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `watcher_session=${encodeURIComponent(
      session.token
    )}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    "watcher_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  );
}

export function normalizeSshTarget(hostValue: unknown, portValue: unknown): SshTarget {
  const rawHost = String(hostValue ?? config.sshHost).trim();
  const host = rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;
  if (
    !host ||
    host.length > 253 ||
    !/^[a-zA-Z0-9._:%-]+$/.test(host)
  ) {
    throw new Error("SSH 主机地址不合法");
  }
  const port = Number(portValue ?? config.sshPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SSH 端口必须是 1 到 65535 之间的整数");
  }
  return { host, port };
}

export function assertAllowedGroups(groups: string[]): void {
  if (config.allowedGroups.length === 0) return;
  const allowed = new Set(config.allowedGroups);
  if (!groups.some((group) => allowed.has(group))) {
    throw new Error(
      `当前账号不在允许登录的用户组中：${config.allowedGroups.join(", ")}`
    );
  }
}

export function connectSsh(
  username: string,
  password: string,
  target: SshTarget = { host: config.sshHost, port: config.sshPort },
  timeoutMs = 10000
): Promise<Client> {
  if (!isSafeUsername(username)) {
    return Promise.reject(new Error("用户名格式不合法"));
  }
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("SSH 登录超时"));
    }, timeoutMs);

    client
      .on("ready", () => {
        clearTimeout(timer);
        resolve(client);
      })
      .on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(error.message || "SSH 登录失败"));
      })
      .connect({
        host: target.host,
        port: target.port,
        username,
        password,
        readyTimeout: timeoutMs,
        tryKeyboard: false
      });
  });
}

interface ExecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function execOnClient(
  client: Client,
  command: string,
  stdin?: string,
  options: ExecOptions = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (
      callback: () => void
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      client.destroy();
      finish(() => reject(new Error("SSH 命令执行超时")));
    }, timeoutMs);

    client.exec(command, { pty: Boolean(stdin) }, (error, stream) => {
      if (error) {
        finish(() => reject(error));
        return;
      }
      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          stream.destroy();
          client.destroy();
          finish(() => reject(new Error("SSH 命令输出过大，已停止读取")));
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      stream.on("data", (chunk: Buffer) => append("stdout", chunk));
      stream.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      stream.on("close", (code: number | null) => {
        finish(() => resolve({ stdout, stderr, code }));
      });
      stream.on("error", (streamError: Error) => {
        finish(() => reject(streamError));
      });
      if (stdin) {
        stream.write(stdin);
        stream.end();
      }
    });
  });
}

export async function authenticateSsh(
  username: string,
  password: string,
  target: SshTarget = { host: config.sshHost, port: config.sshPort }
): Promise<{ username: string; groups: string[]; target: SshTarget }> {
  if (!password) throw new Error("请输入密码");
  const client = await connectSsh(username, password, target);
  let groups: string[] = [];
  try {
    const result = await execOnClient(client, "id -nG", undefined, {
      timeoutMs: 5000,
      maxOutputBytes: 64 * 1024
    });
    groups = result.stdout
      .trim()
      .split(/\s+/)
      .map((group) => group.trim())
      .filter(Boolean);
  } finally {
    client.end();
  }
  assertAllowedGroups(groups);
  return { username, groups, target };
}

export async function execSsh(
  username: string,
  password: string,
  command: string,
  stdin?: string,
  target: SshTarget = { host: config.sshHost, port: config.sshPort },
  options: ExecOptions = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const client = await connectSsh(username, password, target);
  try {
    return await execOnClient(client, command, stdin, options);
  } finally {
    client.end();
  }
}
