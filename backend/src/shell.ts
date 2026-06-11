import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[] = [],
  timeoutMs = 5000
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as Error & {
            code?: string | number;
            signal?: string;
            stdout?: string;
            stderr?: string;
          };
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

export async function tryCommand(
  command: string,
  args: string[] = [],
  timeoutMs = 5000
): Promise<CommandResult | null> {
  try {
    return await runCommand(command, args, timeoutMs);
  } catch {
    return null;
  }
}

export function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^\d.+-]/g, "").trim();
  if (!cleaned || cleaned.toLowerCase() === "nan") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.max(0, Math.min(100, value));
}

export function mbToBytes(value: number | null): number {
  if (value === null) return 0;
  return Math.max(0, Math.round(value * 1024 * 1024));
}
