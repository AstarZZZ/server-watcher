import crypto from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "ssh2";
import { config } from "./config.js";
import { tryCommand } from "./shell.js";

export interface Session {
  token: string;
  username: string;
  groups: string[];
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

export function createSession(username: string, groups: string[]): Session {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const session: Session = {
    token,
    username,
    groups,
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

export async function getUserGroups(username: string): Promise<string[]> {
  if (!isSafeUsername(username)) return [];
  const result = await tryCommand("id", ["-nG", username], 3000);
  if (!result) return [];
  return result.stdout
    .trim()
    .split(/\s+/)
    .map((group) => group.trim())
    .filter(Boolean);
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
        host: config.sshHost,
        port: config.sshPort,
        username,
        password,
        readyTimeout: timeoutMs,
        tryKeyboard: false
      });
  });
}

export async function authenticateSsh(
  username: string,
  password: string
): Promise<{ username: string; groups: string[] }> {
  if (!password) throw new Error("请输入密码");
  const client = await connectSsh(username, password);
  client.end();
  const groups = await getUserGroups(username);
  assertAllowedGroups(groups);
  return { username, groups };
}

export async function execSsh(
  username: string,
  password: string,
  command: string,
  stdin?: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const client = await connectSsh(username, password);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    client.exec(command, { pty: Boolean(stdin) }, (error, stream) => {
      if (error) {
        client.end();
        reject(error);
        return;
      }
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("close", (code: number | null) => {
        client.end();
        resolve({ stdout, stderr, code });
      });
      if (stdin) {
        stream.write(stdin);
        stream.end();
      }
    });
  });
}
