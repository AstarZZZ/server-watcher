import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function listEnv(name: string): string[] {
  const raw = process.env[name] ?? "";
  return raw
    .split(/[,:]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  host: process.env.WATCHER_HOST ?? "0.0.0.0",
  port: numberEnv("WATCHER_PORT", 33099),
  sshHost: process.env.WATCHER_SSH_HOST ?? "127.0.0.1",
  sshPort: numberEnv("WATCHER_SSH_PORT", 22),
  sessionHours: numberEnv("WATCHER_SESSION_HOURS", 12),
  secureCookies: boolEnv("WATCHER_SECURE_COOKIES", false),
  allowedGroups: listEnv("WATCHER_ALLOWED_GROUPS"),
  dataDir: process.env.WATCHER_DATA_DIR ?? path.join(repoRoot, "data"),
  staticDir:
    process.env.WATCHER_STATIC_DIR ??
    path.resolve(here, "../../frontend/dist"),
  storageRoots:
    listEnv("WATCHER_STORAGE_ROOTS").length > 0
      ? listEnv("WATCHER_STORAGE_ROOTS")
      : ["/home"],
  systemdDirs:
    listEnv("WATCHER_SYSTEMD_DIRS").length > 0
      ? listEnv("WATCHER_SYSTEMD_DIRS")
      : ["/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"],
  storageScanHour: numberEnv("WATCHER_STORAGE_SCAN_HOUR", 2),
  processLimit: numberEnv("WATCHER_PROCESS_LIMIT", 250),
  logMaxBytes: numberEnv("WATCHER_LOG_MAX_BYTES", 10 * 1024 * 1024),
  hostname: os.hostname()
};
