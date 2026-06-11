import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { recordEvent } from "./logger.js";
import {
  clampPercent,
  mbToBytes,
  parseNumber,
  runCommand,
  tryCommand
} from "./shell.js";
import type {
  FilesystemInfo,
  GpuInfo,
  GpuProcessInfo,
  MemoryInfo,
  ProcessInfo,
  StorageUsage,
  SystemSnapshot,
  UserUsage
} from "./types.js";

interface CpuCounters {
  idle: number;
  total: number;
}

function splitCsvLine(line: string): string[] {
  return line.split(",").map((item) => item.trim());
}

function toBytesFromKb(kb: number | null): number {
  if (kb === null) return 0;
  return Math.max(0, Math.round(kb * 1024));
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function parseCpuCounters(stat: string | null): CpuCounters | null {
  if (!stat) return null;
  const line = stat.split("\n").find((row) => row.startsWith("cpu "));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.some((value) => !Number.isFinite(value))) return null;
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  const total = parts.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

async function readMemory(): Promise<MemoryInfo> {
  const meminfo = await readText("/proc/meminfo");
  if (!meminfo) {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    return {
      totalBytes,
      freeBytes,
      availableBytes: freeBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0
    };
  }

  const values = new Map<string, number>();
  for (const line of meminfo.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB/i);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }

  const totalBytes = values.get("MemTotal") ?? 0;
  const freeBytes = values.get("MemFree") ?? 0;
  const availableBytes = values.get("MemAvailable") ?? freeBytes;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    totalBytes,
    freeBytes,
    availableBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0
  };
}

async function readFilesystems(): Promise<FilesystemInfo[]> {
  const result = await tryCommand("df", ["-kP"], 5000);
  if (!result) return [];
  return result.stdout
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6)
    .map((parts) => {
      const totalBytes = toBytesFromKb(parseNumber(parts[1]));
      const usedBytes = toBytesFromKb(parseNumber(parts[2]));
      const availableBytes = toBytesFromKb(parseNumber(parts[3]));
      return {
        filesystem: parts[0],
        mount: parts.slice(5).join(" "),
        totalBytes,
        usedBytes,
        availableBytes,
        usedPercent:
          totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : null
      };
    })
    .filter((item) => item.totalBytes > 0);
}

async function readProcesses(): Promise<ProcessInfo[]> {
  const commands = [
    ["ps", ["-eo", "pid=,user=,pcpu=,pmem=,rss=,comm=,args="]],
    ["ps", ["axo", "pid=,user=,pcpu=,pmem=,rss=,comm=,args="]]
  ] as const;

  let output = "";
  for (const [command, args] of commands) {
    const result = await tryCommand(command, [...args], 7000);
    if (result?.stdout) {
      output = result.stdout;
      break;
    }
  }

  if (!output) return [];
  const processes: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      user: match[2],
      cpuPercent: clampPercent(parseNumber(match[3])),
      memoryPercent: clampPercent(parseNumber(match[4])),
      rssBytes: toBytesFromKb(parseNumber(match[5])),
      name: match[6],
      command: match[7] || match[6],
      gpuIndexes: [],
      gpuMemoryBytes: 0
    });
  }
  return processes;
}

async function readGpus(processesByPid: Map<number, ProcessInfo>): Promise<{
  gpus: GpuInfo[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const gpuResult = await tryCommand(
    "nvidia-smi",
    [
      "--query-gpu=index,uuid,name,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,temperature.gpu,power.draw,power.limit,fan.speed",
      "--format=csv,noheader,nounits"
    ],
    6000
  );

  if (!gpuResult) {
    return {
      gpus: [],
      warnings: ["未检测到 nvidia-smi，或当前用户无权读取 NVIDIA GPU 信息。"]
    };
  }

  const gpus: GpuInfo[] = gpuResult.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = splitCsvLine(line);
      const memoryTotal = mbToBytes(parseNumber(parts[5]));
      const memoryUsed = mbToBytes(parseNumber(parts[6]));
      const memoryFree = mbToBytes(parseNumber(parts[7]));
      return {
        index: parseNumber(parts[0]) ?? 0,
        uuid: parts[1] ?? "",
        name: parts[2] ?? "NVIDIA GPU",
        utilizationGpu: clampPercent(parseNumber(parts[3])),
        utilizationMemory: clampPercent(parseNumber(parts[4])),
        memoryTotalBytes: memoryTotal,
        memoryUsedBytes: memoryUsed,
        memoryFreeBytes: memoryFree,
        temperatureC: parseNumber(parts[8]),
        powerDrawW: parseNumber(parts[9]),
        powerLimitW: parseNumber(parts[10]),
        fanSpeedPercent: clampPercent(parseNumber(parts[11])),
        processes: []
      };
    });

  const uuidToGpu = new Map(gpus.map((gpu) => [gpu.uuid, gpu]));
  const processResult = await tryCommand(
    "nvidia-smi",
    [
      "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
      "--format=csv,noheader,nounits"
    ],
    6000
  );

  if (!processResult?.stdout.trim()) {
    return { gpus, warnings };
  }

  for (const line of processResult.stdout.trim().split("\n")) {
    if (!line || /no running/i.test(line)) continue;
    const parts = splitCsvLine(line);
    const gpu = uuidToGpu.get(parts[0]);
    const pid = parseNumber(parts[1]);
    if (!gpu || pid === null) continue;
    const process = processesByPid.get(pid);
    const gpuMemoryBytes = mbToBytes(parseNumber(parts[3]));
    const gpuProcess: GpuProcessInfo = {
      gpuIndex: gpu.index,
      gpuUuid: gpu.uuid,
      pid,
      user: process?.user ?? "unknown",
      name: parts[2] || process?.name || "process",
      command: process?.command ?? parts[2] ?? "process",
      gpuMemoryBytes,
      cpuPercent: process?.cpuPercent ?? null,
      memoryPercent: process?.memoryPercent ?? null,
      rssBytes: process?.rssBytes ?? 0
    };
    gpu.processes.push(gpuProcess);
    if (process) {
      process.gpuIndexes = Array.from(
        new Set([...process.gpuIndexes, gpu.index])
      ).sort((a, b) => a - b);
      process.gpuMemoryBytes += gpuMemoryBytes;
    }
  }

  return { gpus, warnings };
}

async function loadStorage(): Promise<StorageUsage[]> {
  const file = path.join(config.dataDir, "storage.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as StorageUsage[];
  } catch {
    return [];
  }
}

async function saveStorage(storage: StorageUsage[]): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(
    path.join(config.dataDir, "storage.json"),
    JSON.stringify(storage, null, 2),
    "utf8"
  );
}

async function duBytes(targetPath: string): Promise<number> {
  const result = await runCommand("du", ["-sk", targetPath], 60_000);
  const kb = parseNumber(result.stdout.trim().split(/\s+/)[0]);
  return toBytesFromKb(kb);
}

async function discoverStorageTargets(): Promise<{ user: string; path: string }[]> {
  const targets: { user: string; path: string }[] = [];
  for (const root of config.storageRoots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".")) continue;
        targets.push({ user: entry.name, path: path.join(root, entry.name) });
      }
    } catch {
      // Some roots do not exist or are not readable on every host.
    }
  }
  return targets;
}

export async function scanStorage(): Promise<StorageUsage[]> {
  const scannedAt = new Date().toISOString();
  const targets = await discoverStorageTargets();
  const storage: StorageUsage[] = [];
  for (const target of targets) {
    try {
      const bytes = await duBytes(target.path);
      storage.push({
        user: target.user,
        path: target.path,
        bytes,
        scannedAt,
        status: "ok"
      });
    } catch (error) {
      storage.push({
        user: target.user,
        path: target.path,
        bytes: 0,
        scannedAt,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  await saveStorage(storage);
  await recordEvent("storage.scan", "完成存储空间扫描", undefined, {
    count: storage.length
  });
  return storage;
}

function aggregateUsers(
  processes: ProcessInfo[],
  storage: StorageUsage[]
): UserUsage[] {
  const users = new Map<string, UserUsage>();
  for (const process of processes) {
    const existing =
      users.get(process.user) ??
      ({
        user: process.user,
        processCount: 0,
        cpuPercent: 0,
        rssBytes: 0,
        gpuMemoryBytes: 0,
        gpuIndexes: []
      } satisfies UserUsage);
    existing.processCount += 1;
    existing.cpuPercent += process.cpuPercent ?? 0;
    existing.rssBytes += process.rssBytes;
    existing.gpuMemoryBytes += process.gpuMemoryBytes;
    existing.gpuIndexes = Array.from(
      new Set([...existing.gpuIndexes, ...process.gpuIndexes])
    ).sort((a, b) => a - b);
    users.set(process.user, existing);
  }

  for (const item of storage) {
    const existing =
      users.get(item.user) ??
      ({
        user: item.user,
        processCount: 0,
        cpuPercent: 0,
        rssBytes: 0,
        gpuMemoryBytes: 0,
        gpuIndexes: []
      } satisfies UserUsage);
    existing.storageBytes = item.bytes;
    users.set(item.user, existing);
  }

  return Array.from(users.values()).sort((a, b) => {
    const left = b.gpuMemoryBytes - a.gpuMemoryBytes;
    if (left !== 0) return left;
    return b.cpuPercent - a.cpuPercent;
  });
}

export class Collector extends EventEmitter {
  private snapshot: SystemSnapshot | null = null;
  private previousCpu: CpuCounters | null = null;
  private timer: NodeJS.Timeout | null = null;
  private collecting = false;
  private lastCollectionAt = 0;
  private lastStorageScanDay = "";

  constructor(private readonly getActiveClients: () => number) {
    super();
  }

  getSnapshot(): SystemSnapshot | null {
    return this.snapshot;
  }

  start(): void {
    if (this.timer) return;
    void this.collect("startup");
    this.timer = setInterval(() => {
      const active = this.getActiveClients() > 0;
      const idleDue = Date.now() - this.lastCollectionAt > 60 * 60 * 1000;
      if (active || idleDue) void this.collect(active ? "active" : "idle");
      void this.maybeScanStorage();
    }, 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async forceCollect(reason = "manual"): Promise<SystemSnapshot> {
    return this.collect(reason);
  }

  async forceStorageScan(): Promise<StorageUsage[]> {
    const storage = await scanStorage();
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        storage,
        users: aggregateUsers(this.snapshot.processes, storage)
      };
      this.emit("snapshot", this.snapshot);
    }
    return storage;
  }

  private async maybeScanStorage(): Promise<void> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() !== config.storageScanHour) return;
    if (this.lastStorageScanDay === day) return;
    this.lastStorageScanDay = day;
    await this.forceStorageScan();
  }

  private async collect(reason: string): Promise<SystemSnapshot> {
    if (this.collecting && this.snapshot) return this.snapshot;
    this.collecting = true;
    this.lastCollectionAt = Date.now();
    const warnings: string[] = [];
    try {
      const stat = await readText("/proc/stat");
      const currentCpu = parseCpuCounters(stat);
      let usagePercent: number | null = null;
      if (currentCpu && this.previousCpu) {
        const totalDelta = currentCpu.total - this.previousCpu.total;
        const idleDelta = currentCpu.idle - this.previousCpu.idle;
        if (totalDelta > 0) {
          usagePercent = clampPercent(
            ((totalDelta - idleDelta) / totalDelta) * 100
          );
        }
      } else if (!fsSync.existsSync("/proc/stat")) {
        usagePercent = clampPercent((os.loadavg()[0] / os.cpus().length) * 100);
      }
      this.previousCpu = currentCpu;

      const [memory, filesystems, allProcesses, storage] = await Promise.all([
        readMemory(),
        readFilesystems(),
        readProcesses(),
        loadStorage()
      ]);
      const processesByPid = new Map(allProcesses.map((item) => [item.pid, item]));
      const gpuResult = await readGpus(processesByPid);
      warnings.push(...gpuResult.warnings);
      const visibleProcesses = allProcesses
        .sort((a, b) => {
          const gpuDelta = b.gpuMemoryBytes - a.gpuMemoryBytes;
          if (gpuDelta !== 0) return gpuDelta;
          return (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0);
        })
        .slice(0, config.processLimit);

      const snapshot: SystemSnapshot = {
        timestamp: new Date().toISOString(),
        hostname: config.hostname,
        uptimeSeconds: os.uptime(),
        activeClients: this.getActiveClients(),
        collectionReason: reason,
        cpu: {
          usagePercent,
          loadAverage: os.loadavg(),
          cores: os.cpus().length
        },
        memory,
        filesystems,
        gpus: gpuResult.gpus,
        processes: visibleProcesses,
        users: aggregateUsers(allProcesses, storage),
        storage,
        warnings
      };

      this.snapshot = snapshot;
      this.emit("snapshot", snapshot);
      if (reason !== "active") {
        await recordEvent("collector.snapshot", `完成${reason}采集`, undefined, {
          gpuCount: snapshot.gpus.length,
          processCount: snapshot.processes.length,
          activeClients: snapshot.activeClients
        });
      }
      return snapshot;
    } finally {
      this.collecting = false;
    }
  }
}
