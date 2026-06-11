export interface GpuProcessInfo {
  gpuIndex: number;
  gpuUuid: string;
  pid: number;
  user: string;
  name: string;
  command: string;
  gpuMemoryBytes: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  rssBytes: number;
}

export interface GpuInfo {
  index: number;
  uuid: string;
  name: string;
  utilizationGpu: number | null;
  utilizationMemory: number | null;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryFreeBytes: number;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
  fanSpeedPercent: number | null;
  processes: GpuProcessInfo[];
}

export interface ProcessInfo {
  pid: number;
  user: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  rssBytes: number;
  name: string;
  command: string;
  gpuIndexes: number[];
  gpuMemoryBytes: number;
}

export interface UserUsage {
  user: string;
  processCount: number;
  cpuPercent: number;
  rssBytes: number;
  gpuMemoryBytes: number;
  gpuIndexes: number[];
  storageBytes?: number;
}

export interface FilesystemInfo {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number | null;
}

export interface StorageUsage {
  user: string;
  path: string;
  bytes: number;
  scannedAt: string;
  status: "ok" | "error";
  error?: string;
}

export interface AutostartItem {
  source: "systemd" | "cron" | "pm2" | "docker" | "supervisor";
  name: string;
  state: string;
  description?: string;
  command?: string;
  user?: string;
  raw?: string;
}

export interface WatcherEvent {
  id: string;
  timestamp: string;
  type: string;
  actor?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SystemSnapshot {
  timestamp: string;
  hostname: string;
  uptimeSeconds: number;
  activeClients: number;
  collectionReason: string;
  cpu: {
    usagePercent: number | null;
    loadAverage: number[];
    cores: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    availableBytes: number;
    usedPercent: number;
  };
  filesystems: FilesystemInfo[];
  gpus: GpuInfo[];
  processes: ProcessInfo[];
  users: UserUsage[];
  storage: StorageUsage[];
  warnings: string[];
}

export interface Me {
  username: string;
  groups: string[];
  expiresAt: string;
}
