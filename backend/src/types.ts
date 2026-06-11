export type NullableNumber = number | null;

export interface GpuProcessInfo {
  gpuIndex: number;
  gpuUuid: string;
  pid: number;
  user: string;
  name: string;
  command: string;
  gpuMemoryBytes: number;
  cpuPercent: NullableNumber;
  memoryPercent: NullableNumber;
  rssBytes: number;
}

export interface GpuInfo {
  index: number;
  uuid: string;
  name: string;
  utilizationGpu: NullableNumber;
  utilizationMemory: NullableNumber;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryFreeBytes: number;
  temperatureC: NullableNumber;
  powerDrawW: NullableNumber;
  powerLimitW: NullableNumber;
  fanSpeedPercent: NullableNumber;
  processes: GpuProcessInfo[];
}

export interface ProcessInfo {
  pid: number;
  user: string;
  cpuPercent: NullableNumber;
  memoryPercent: NullableNumber;
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

export interface MemoryInfo {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface CpuInfo {
  usagePercent: NullableNumber;
  loadAverage: number[];
  cores: number;
}

export interface FilesystemInfo {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: NullableNumber;
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
  cpu: CpuInfo;
  memory: MemoryInfo;
  filesystems: FilesystemInfo[];
  gpus: GpuInfo[];
  processes: ProcessInfo[];
  users: UserUsage[];
  storage: StorageUsage[];
  warnings: string[];
}
