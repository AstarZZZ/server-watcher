import { execSsh, type Session } from "./auth.js";

const maxDirectoryEntries = 500;

export type RemoteFileKind = "directory" | "file" | "symlink" | "other";

export interface RemoteFileEntry {
  name: string;
  path: string;
  kind: RemoteFileKind;
  sizeBytes: number;
  modifiedAt: string;
  hidden: boolean;
}

export interface RemoteFileListing {
  home: string;
  path: string;
  parent: string | null;
  entries: RemoteFileEntry[];
  totalBytes: number;
  truncated: boolean;
  cached: boolean;
  scannedAt: string;
}

interface CachedListing {
  listing: RemoteFileListing;
  expiresAt: number;
}

const listingCache = new Map<string, Map<string, CachedListing>>();
const listingCacheTtlMs = 15 * 60 * 1000;
const maxCachedPathsPerSession = 64;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertRemotePath(value: string): void {
  if (!value.startsWith("/") || value.includes("\0") || value.length > 4096) {
    throw new Error("远程路径不合法");
  }
}

function fileKind(value: string): RemoteFileKind {
  if (value === "d") return "directory";
  if (value === "f") return "file";
  if (value === "l") return "symlink";
  return "other";
}

function timestampToIso(value: string): string {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds)) return new Date(0).toISOString();
  return new Date(seconds * 1000).toISOString();
}

export function parseRemoteFileListing(output: string): RemoteFileListing {
  const tokens = output.split("\0");
  let index = 0;
  let home = "";
  let currentPath = "";
  let truncated = false;
  const entries: RemoteFileEntry[] = [];
  const sizes = new Map<string, number>();

  while (index < tokens.length) {
    const token = tokens[index++];
    if (!token) continue;
    if (token === "HOME") {
      home = tokens[index++] ?? "";
      continue;
    }
    if (token === "PATH") {
      currentPath = tokens[index++] ?? "";
      continue;
    }
    if (token === "TRUNCATED") {
      truncated = tokens[index++] === "1";
      continue;
    }
    if (token === "ENTRY") {
      const name = tokens[index++] ?? "";
      const kind = fileKind(tokens[index++] ?? "");
      const fallbackSize = Number(tokens[index++] ?? 0);
      const modifiedAt = timestampToIso(tokens[index++] ?? "0");
      const entryPath = tokens[index++] ?? "";
      if (name && entryPath) {
        entries.push({
          name,
          path: entryPath,
          kind,
          sizeBytes: Number.isFinite(fallbackSize) ? Math.max(0, fallbackSize) : 0,
          modifiedAt,
          hidden: name.startsWith(".")
        });
      }
      continue;
    }
    if (token === "SIZES") {
      while (index < tokens.length) {
        const record = tokens[index++];
        if (!record) continue;
        const separator = record.indexOf("\t");
        if (separator < 1) continue;
        const size = Number(record.slice(0, separator));
        const entryPath = record.slice(separator + 1);
        if (entryPath && Number.isFinite(size)) {
          sizes.set(entryPath, Math.max(0, size));
        }
      }
    }
  }

  if (!home || !currentPath) throw new Error("无法解析远程目录信息");
  for (const entry of entries) {
    entry.sizeBytes = sizes.get(entry.path) ?? entry.sizeBytes;
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const parent = currentPath === home
    ? null
    : currentPath.slice(0, currentPath.lastIndexOf("/")) || "/";
  return {
    home,
    path: currentPath,
    parent,
    entries,
    totalBytes,
    truncated,
    cached: false,
    scannedAt: new Date().toISOString()
  };
}

export function buildListFilesCommand(requestedPath?: string): string {
  if (requestedPath) assertRemotePath(requestedPath);
  const requested = requestedPath ? shellQuote(requestedPath) : '"$home"';
  const script = `
set -uo pipefail
home_source=$(getent passwd "$(id -un)" 2>/dev/null | awk -F: 'NR == 1 { print $6 }')
if [[ -z "$home_source" ]]; then home_source="$HOME"; fi
home=$(readlink -f -- "$home_source") || { echo "无法读取账户主目录" >&2; exit 41; }
requested=${requested}
target=$(readlink -f -- "$requested") || { echo "目录不存在或无权访问" >&2; exit 42; }
case "$target" in
  "$home"|"$home"/*) ;;
  *) echo "只能浏览当前 SSH 账户的主目录" >&2; exit 43 ;;
esac
[[ -d "$target" ]] || { echo "所选路径不是目录" >&2; exit 44; }
mapfile -d '' -t all_entries < <(find "$target" -mindepth 1 -maxdepth 1 -print0 2>/dev/null | head -z -n ${maxDirectoryEntries + 1})
truncated=0
if (( \${#all_entries[@]} > ${maxDirectoryEntries} )); then truncated=1; fi
entries=("\${all_entries[@]:0:${maxDirectoryEntries}}")
printf 'HOME\\0%s\\0PATH\\0%s\\0TRUNCATED\\0%s\\0' "$home" "$target" "$truncated"
for item in "\${entries[@]}"; do
  name=\${item##*/}
  if [[ -L "$item" ]]; then kind=l
  elif [[ -d "$item" ]]; then kind=d
  elif [[ -f "$item" ]]; then kind=f
  else kind=o
  fi
  fallback_size=$(stat -c '%s' -- "$item" 2>/dev/null || printf '0')
  modified=$(stat -c '%Y' -- "$item" 2>/dev/null || printf '0')
  printf 'ENTRY\\0%s\\0%s\\0%s\\0%s\\0%s\\0' "$name" "$kind" "$fallback_size" "$modified" "$item"
done
printf 'SIZES\\0'
if (( \${#entries[@]} > 0 )); then
  du -sb --count-links --null -- "\${entries[@]}" 2>/dev/null || true
fi
`;
  return `bash -lc ${shellQuote(script)}`;
}

function buildDeleteFilesCommand(paths: string[]): string {
  for (const item of paths) assertRemotePath(item);
  const quotedPaths = paths.map(shellQuote).join(" ");
  const script = `
set -euo pipefail
home_source=$(getent passwd "$(id -un)" 2>/dev/null | awk -F: 'NR == 1 { print $6 }')
if [[ -z "$home_source" ]]; then home_source="$HOME"; fi
home=$(readlink -f -- "$home_source") || { echo "无法读取账户主目录" >&2; exit 41; }
for candidate in ${quotedPaths}; do
  [[ "$candidate" != "$home" ]] || { echo "不能删除账户主目录" >&2; exit 45; }
  parent=$(dirname -- "$candidate")
  base=$(basename -- "$candidate")
  [[ "$base" != "." && "$base" != ".." && -n "$base" ]] || { echo "删除路径不合法" >&2; exit 46; }
  parent_real=$(readlink -f -- "$parent") || { echo "文件的上级目录不存在" >&2; exit 47; }
  case "$parent_real" in
    "$home"|"$home"/*) ;;
    *) echo "只能删除当前 SSH 账户主目录内的文件" >&2; exit 48 ;;
  esac
  target="$parent_real/$base"
  [[ -e "$target" || -L "$target" ]] || { echo "文件不存在：$candidate" >&2; exit 49; }
done
for candidate in ${quotedPaths}; do
  parent_real=$(readlink -f -- "$(dirname -- "$candidate")")
  base=$(basename -- "$candidate")
  rm -rf -- "$parent_real/$base"
done
printf '已永久删除 %s 个项目\\n' "$#"
`;
  return `bash -lc ${shellQuote(script)} -- ${quotedPaths}`;
}

function sessionTarget(session: Session) {
  return { host: session.host, port: session.port };
}

function cacheKey(requestedPath?: string): string {
  return requestedPath || "@home";
}

function readCachedListing(
  session: Session,
  requestedPath?: string
): RemoteFileListing | null {
  const sessionCache = listingCache.get(session.token);
  if (!sessionCache) return null;
  const key = cacheKey(requestedPath);
  const cached = sessionCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    sessionCache.delete(key);
    if (sessionCache.size === 0) listingCache.delete(session.token);
    return null;
  }
  sessionCache.delete(key);
  sessionCache.set(key, cached);
  return { ...cached.listing, cached: true };
}

function writeCachedListing(
  session: Session,
  requestedPath: string | undefined,
  listing: RemoteFileListing
): void {
  let sessionCache = listingCache.get(session.token);
  if (!sessionCache) {
    sessionCache = new Map();
    listingCache.set(session.token, sessionCache);
  }
  const cached: CachedListing = {
    listing: { ...listing, cached: false },
    expiresAt: Date.now() + listingCacheTtlMs
  };
  sessionCache.set(cacheKey(requestedPath), cached);
  sessionCache.set(cacheKey(listing.path), cached);
  if (listing.path === listing.home) sessionCache.set("@home", cached);
  while (sessionCache.size > maxCachedPathsPerSession) {
    const oldestKey = sessionCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    sessionCache.delete(oldestKey);
  }
}

export function clearRemoteFileCache(sessionToken: string): void {
  listingCache.delete(sessionToken);
}

export async function listRemoteFiles(
  session: Session,
  password: string,
  requestedPath?: string,
  forceRefresh = false
): Promise<RemoteFileListing> {
  if (!password) throw new Error("请输入 SSH 密码");
  if (!forceRefresh) {
    const cached = readCachedListing(session, requestedPath);
    if (cached) return cached;
  }
  const command = buildListFilesCommand(requestedPath);
  const result = await execSsh(
    session.username,
    password,
    command,
    undefined,
    sessionTarget(session),
    { timeoutMs: 180_000, maxOutputBytes: 32 * 1024 * 1024 }
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "无法读取远程目录");
  }
  const listing = parseRemoteFileListing(result.stdout);
  writeCachedListing(session, requestedPath, listing);
  return listing;
}

export async function deleteRemoteFiles(
  session: Session,
  password: string,
  paths: string[],
  confirmation: string
): Promise<{ deleted: number; stdout: string }> {
  if (!password) throw new Error("请输入 SSH 密码");
  if (confirmation !== "永久删除") throw new Error("请输入“永久删除”进行确认");
  const uniquePaths = Array.from(new Set(paths));
  if (uniquePaths.length === 0) throw new Error("请至少选择一个文件或文件夹");
  if (uniquePaths.length > 100) throw new Error("单次最多删除 100 个项目");
  const result = await execSsh(
    session.username,
    password,
    buildDeleteFilesCommand(uniquePaths),
    undefined,
    sessionTarget(session),
    { timeoutMs: 180_000, maxOutputBytes: 1024 * 1024 }
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "删除失败");
  }
  clearRemoteFileCache(session.token);
  return { deleted: uniquePaths.length, stdout: result.stdout.trim() };
}
