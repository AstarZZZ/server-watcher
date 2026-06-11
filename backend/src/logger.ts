import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { WatcherEvent } from "./types.js";

const logFile = path.join(config.dataDir, "events.jsonl");

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const stat = await fs.stat(logFile);
    if (stat.size <= config.logMaxBytes) return;
    const rotated = path.join(config.dataDir, `events.${Date.now()}.jsonl`);
    await fs.rename(logFile, rotated);
  } catch {
    // Missing log file is fine.
  }
}

export async function recordEvent(
  type: string,
  message: string,
  actor?: string,
  details?: Record<string, unknown>
): Promise<WatcherEvent> {
  await ensureDataDir();
  await rotateIfNeeded();
  const event: WatcherEvent = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    actor,
    message,
    details
  };
  await fs.appendFile(logFile, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function readEvents(limit = 200): Promise<WatcherEvent[]> {
  try {
    const text = await fs.readFile(logFile, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(1000, limit)))
      .map((line) => JSON.parse(line) as WatcherEvent)
      .reverse();
  } catch {
    return [];
  }
}
