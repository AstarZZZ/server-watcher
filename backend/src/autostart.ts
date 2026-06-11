import fs from "node:fs/promises";
import path from "node:path";
import { tryCommand } from "./shell.js";
import type { AutostartItem } from "./types.js";

async function systemdItems(): Promise<AutostartItem[]> {
  const units = await tryCommand(
    "systemctl",
    [
      "list-unit-files",
      "--type=service",
      "--state=enabled,generated,static",
      "--no-pager",
      "--plain"
    ],
    7000
  );
  if (!units) return [];

  const active = await tryCommand(
    "systemctl",
    ["list-units", "--type=service", "--all", "--no-pager", "--plain"],
    7000
  );
  const activeMap = new Map<string, string>();
  if (active?.stdout) {
    for (const line of active.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[0]?.endsWith(".service")) {
        activeMap.set(parts[0], parts.slice(1, 4).join(" "));
      }
    }
  }

  return units.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".service") || line.includes(".service "))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[0]?.endsWith(".service"))
    .slice(0, 300)
    .map((parts) => ({
      source: "systemd" as const,
      name: parts[0],
      state: `${parts[1] ?? "unknown"}${activeMap.has(parts[0]) ? ` / ${activeMap.get(parts[0])}` : ""}`,
      description: parts.slice(2).join(" ") || undefined
    }));
}

async function cronItems(): Promise<AutostartItem[]> {
  const items: AutostartItem[] = [];
  const crontab = await readCronFile("/etc/crontab", "system");
  items.push(...crontab);

  try {
    const entries = await fs.readdir("/etc/cron.d", { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      items.push(
        ...(await readCronFile(path.join("/etc/cron.d", entry.name), "system"))
      );
    }
  } catch {
    // cron.d might not exist on minimal images.
  }
  return items.slice(0, 200);
}

async function readCronFile(file: string, user: string): Promise<AutostartItem[]> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line, index) => ({
        source: "cron" as const,
        name: `${path.basename(file)}:${index + 1}`,
        user,
        state: "configured",
        command: line,
        raw: line
      }));
  } catch {
    return [];
  }
}

async function pm2Items(): Promise<AutostartItem[]> {
  const result = await tryCommand("pm2", ["jlist"], 7000);
  if (!result?.stdout) return [];
  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      name?: string;
      pm_id?: number;
      pm2_env?: {
        status?: string;
        pm_exec_path?: string;
        restart_time?: number;
        username?: string;
      };
    }>;
    return parsed.slice(0, 200).map((item) => ({
      source: "pm2" as const,
      name: item.name ?? `pm2-${item.pm_id ?? "unknown"}`,
      state: item.pm2_env?.status ?? "unknown",
      command: item.pm2_env?.pm_exec_path,
      user: item.pm2_env?.username,
      description:
        item.pm2_env?.restart_time !== undefined
          ? `restarts: ${item.pm2_env.restart_time}`
          : undefined
    }));
  } catch {
    return [];
  }
}

async function dockerItems(): Promise<AutostartItem[]> {
  const result = await tryCommand(
    "docker",
    [
      "ps",
      "--format",
      "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.RunningFor}}\t{{.Label \"com.docker.compose.project\"}}"
    ],
    7000
  );
  if (!result?.stdout) return [];
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => {
      const [name, image, status, runningFor, project] = line.split("\t");
      return {
        source: "docker" as const,
        name,
        state: status ?? "running",
        description: [image, runningFor, project].filter(Boolean).join(" / "),
        command: "docker ps"
      };
    });
}

async function supervisorItems(): Promise<AutostartItem[]> {
  const result = await tryCommand("supervisorctl", ["status"], 7000);
  if (!result?.stdout) return [];
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        source: "supervisor" as const,
        name: parts[0] ?? "supervisor-process",
        state: parts[1] ?? "unknown",
        description: parts.slice(2).join(" "),
        raw: line
      };
    });
}

export async function listAutostartItems(): Promise<AutostartItem[]> {
  const groups = await Promise.all([
    systemdItems(),
    cronItems(),
    pm2Items(),
    dockerItems(),
    supervisorItems()
  ]);
  return groups.flat();
}

export function isValidSystemdService(name: string): boolean {
  return /^[a-zA-Z0-9_.@:-]+\.service$/.test(name);
}

export function isValidSystemdAction(action: string): action is
  | "start"
  | "stop"
  | "restart"
  | "enable"
  | "disable" {
  return ["start", "stop", "restart", "enable", "disable"].includes(action);
}
