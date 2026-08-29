import type {
  AutostartItem,
  Me,
  RemoteFileListing,
  SystemSnapshot,
  WatcherEvent
} from "./types";

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? body.stderr ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export function login(
  host: string,
  port: number,
  username: string,
  password: string
): Promise<Me> {
  return request<Me>("/api/login", {
    method: "POST",
    body: JSON.stringify({ host, port, username, password })
  });
}

export function logout(): Promise<{ ok: true }> {
  return request<{ ok: true }>("/api/logout", { method: "POST" });
}

export function me(): Promise<Me> {
  return request<Me>("/api/me");
}

export function getSnapshot(): Promise<SystemSnapshot> {
  return request<SystemSnapshot>("/api/snapshot");
}

export function refreshSnapshot(): Promise<SystemSnapshot> {
  return request<SystemSnapshot>("/api/snapshot/refresh", { method: "POST" });
}

export function getLogs(limit = 200): Promise<{ events: WatcherEvent[] }> {
  return request<{ events: WatcherEvent[] }>(`/api/logs?limit=${limit}`);
}

export function getAutostart(): Promise<{ items: AutostartItem[] }> {
  return request<{ items: AutostartItem[] }>("/api/autostart");
}

export function sendSignal(
  pid: number,
  signal: "TERM" | "KILL" | "INT" | "HUP",
  password: string,
  sudo: boolean
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return request(`/api/process/${pid}/signal`, {
    method: "POST",
    body: JSON.stringify({ signal, password, sudo })
  });
}

export function scanStorage(
  password: string
): Promise<{ storage: SystemSnapshot["storage"] }> {
  return request("/api/storage/scan", {
    method: "POST",
    body: JSON.stringify({ password })
  });
}

export function systemdAction(
  service: string,
  action: "start" | "stop" | "restart" | "enable" | "disable",
  password: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return request("/api/autostart/systemd/action", {
    method: "POST",
    body: JSON.stringify({ service, action, password })
  });
}

export function listRemoteFiles(
  password: string,
  path?: string,
  refresh = false
): Promise<RemoteFileListing> {
  return request("/api/files/list", {
    method: "POST",
    body: JSON.stringify({ password, path, refresh })
  });
}

export function deleteRemoteFiles(
  password: string,
  paths: string[],
  confirmation: string
): Promise<{ deleted: number; stdout: string }> {
  return request("/api/files/delete", {
    method: "POST",
    body: JSON.stringify({ password, paths, confirmation })
  });
}
