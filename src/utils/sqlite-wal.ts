import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SQLite WAL 合并读取。
 *
 * sql.js 只能打开独立的数据库镜像，无法理解 `-wal` 侧车文件。当游戏数据库
 * 处于 WAL 日志模式时，其他程序（运行中的 M2、GM 工具）提交的数据可能仍留在
 * `<file>-wal` 中尚未合并进主库，直接读取主库会看到过期内容。此模块按 SQLite
 * 官方文件格式（https://www.sqlite.org/fileformat2.html#walformat）把已提交的
 * WAL 帧合并进主库镜像，得到与最新提交一致的只读快照。
 */

export interface SqliteDatabaseImage {
  /** 合并后的数据库镜像（可安全传给 `new SQL.Database`）。 */
  data: Buffer;
  /** 是否成功合并了 WAL 中已提交的帧。 */
  walMerged: boolean;
  /** 合并后的数据库页数（仅 walMerged 时有效）。 */
  walPageCount?: number;
  /** 合并的已提交帧数量（仅 walMerged 时有效）。 */
  walFrameCount?: number;
  /**
   * 数据库当前状态的指纹：同时覆盖主库与 `-wal` 侧车文件。
   * 外部修改检测必须使用该指纹而不是仅对主库做哈希，否则外部程序
   * 通过 WAL 提交的新数据不会被察觉，旧快照落盘时会静默覆盖它们。
   */
  stateSha256: string;
}

const WAL_HEADER_SIZE = 32;
const WAL_FRAME_HEADER_SIZE = 24;
// 魔数低位承载校验和字序（SQLite 写入 `WAL_MAGIC | SQLITE_BIGENDIAN`）：
// 0x377f0682 → 小端字序，0x377f0683 → 大端字序；校验和数值本身总是按大端存储。
const WAL_MAGIC_LITTLE_ENDIAN = 0x377f0682;
const WAL_MAGIC_BIG_ENDIAN = 0x377f0683;
const WAL_FORMAT_VERSION = 3007000;
const MIN_PAGE_SIZE = 512;
const MAX_PAGE_SIZE = 65536;

export function sqliteWalPath(filePath: string): string {
  return `${filePath}-wal`;
}

/**
 * 删除 `-wal` 与 `-shm` 侧车文件。写入完整镜像前必须调用：旧 WAL 残留时，
 * SQLite 下次打开会按旧帧回放覆盖刚写入的新库。`-wal` 删除失败（如被运行中
 * 的 M2 占用）会抛错中止保存；`-shm` 只是索引缓存，删除失败可容忍。
 */
export function removeSqliteSidecarFiles(filePath: string): void {
  try { fs.unlinkSync(sqliteWalPath(filePath)); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  try { fs.unlinkSync(`${filePath}-shm`); } catch { /* rebuildable index */ }
}

/**
 * 把 `createDatabaseBackup` 产生的备份（主库 + 可选 `-wal`）还原到目标路径。
 * 备份没有 WAL 时会清掉目标当前残留的 `-wal`，保证恢复后的状态与备份时刻一致。
 */
export function restoreSqliteBackup(backupPath: string, filePath: string): void {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.boo-restore-${process.pid}-${Date.now()}.tmp`
  );
  fs.copyFileSync(backupPath, temporaryPath);
  fs.copyFileSync(temporaryPath, filePath);
  try { fs.unlinkSync(temporaryPath); } catch { /* best effort */ }

  const walBackupPath = `${backupPath}-wal`;
  if (fs.existsSync(walBackupPath)) {
    fs.copyFileSync(walBackupPath, sqliteWalPath(filePath));
  } else {
    try { fs.unlinkSync(sqliteWalPath(filePath)); } catch { /* already absent */ }
  }
  try { fs.unlinkSync(`${filePath}-shm`); } catch { /* rebuildable index */ }
}

/**
 * 计算数据库状态指纹：主库字节 + WAL 侧车字节（若有）。
 * 对 MDB 等没有 `-wal` 侧车的文件等价于普通文件哈希。
 */
export function sqliteStateSha256(filePath: string): string {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath));
  const walPath = sqliteWalPath(filePath);
  try {
    const wal = fs.readFileSync(walPath);
    hash.update('boo-wal:');
    hash.update(wal);
  } catch {
    hash.update('boo-nowal');
  }
  return hash.digest('hex');
}

/**
 * 读取数据库镜像并合并 WAL 中已提交的帧。
 * 任何格式异常（魔数/版本/页大小/校验和不匹配）都按"没有有效 WAL"处理，
 * 退回主库本身，绝不抛错——读取路径必须始终可用。
 */
export function readSqliteDatabaseImage(filePath: string): SqliteDatabaseImage {
  let database: Buffer;
  try {
    database = fs.readFileSync(filePath);
  } catch {
    database = Buffer.alloc(0);
  }
  let wal: Buffer;
  try {
    wal = fs.readFileSync(sqliteWalPath(filePath));
  } catch {
    wal = Buffer.alloc(0);
  }
  const stateSha256 = sqliteStateSha256(filePath);

  const frames = collectCommittedWalFrames(wal);
  if (!frames) return { data: database, walMerged: false, stateSha256 };

  const pageSize = frames.pageSize;
  // 页大小必须与主库一致（主库为空时允许 WAL 单独构成数据库）。
  if (database.length > 0) {
    if (database.length % pageSize !== 0) return { data: database, walMerged: false, stateSha256 };
    const dbHeaderPageSize = readDatabasePageSize(database);
    if (dbHeaderPageSize !== undefined && dbHeaderPageSize !== pageSize) {
      return { data: database, walMerged: false, stateSha256 };
    }
  }

  const basePages = Math.floor(database.length / pageSize);
  let finalPages = basePages;
  for (const pageNumber of frames.committed.keys()) {
    if (pageNumber > finalPages) finalPages = pageNumber;
  }
  // 最后一次提交声明的库大小是权威值，但只接受不超过已知页范围的
  // 收缩/扩张，防止损坏的头部申请出超大内存。
  if (frames.dbSizeAfterCommit !== undefined && frames.dbSizeAfterCommit <= frames.maxKnownPage) {
    finalPages = Math.min(frames.dbSizeAfterCommit, Math.max(basePages, frames.maxKnownPage));
  }
  if (finalPages <= 0) return { data: database, walMerged: false, stateSha256 };

  const merged = Buffer.alloc(finalPages * pageSize);
  database.copy(merged, 0, 0, Math.min(database.length, merged.length));
  for (const [pageNumber, page] of frames.committed) {
    if (pageNumber < 1 || pageNumber > finalPages) continue;
    page.copy(merged, (pageNumber - 1) * pageSize);
  }
  return {
    data: merged,
    walMerged: true,
    walPageCount: finalPages,
    walFrameCount: frames.committedFrameCount,
    stateSha256,
  };
}

interface CommittedWalFrames {
  pageSize: number;
  /** 页号 -> 该页在最后一次提交事务中的最新内容。 */
  committed: Map<number, Buffer>;
  committedFrameCount: number;
  /** 最后一个提交帧声明的提交后库大小（页）。 */
  dbSizeAfterCommit?: number;
  /** WAL 中出现过的最大页号。 */
  maxKnownPage: number;
}

/** 解析 WAL，返回最后一条已提交事务的页面状态；WAL 无效或没有提交帧时返回 undefined。 */
function collectCommittedWalFrames(wal: Buffer): CommittedWalFrames | undefined {
  if (wal.length < WAL_HEADER_SIZE) return undefined;
  const magic = wal.readUInt32BE(0);
  const bigEndian = magic === WAL_MAGIC_BIG_ENDIAN;
  if (!bigEndian && magic !== WAL_MAGIC_LITTLE_ENDIAN) return undefined;
  if (wal.readUInt32BE(4) !== WAL_FORMAT_VERSION) return undefined;
  const pageSize = wal.readUInt32BE(8);
  if (pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE || (pageSize & (pageSize - 1)) !== 0) return undefined;
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  const [headerChecksum0, headerChecksum1] = walChecksum(wal, 0, 24, 0, 0, bigEndian);
  if (headerChecksum0 !== wal.readUInt32BE(24) || headerChecksum1 !== wal.readUInt32BE(28)) {
    return undefined;
  }

  const committed = new Map<number, Buffer>();
  const pending = new Map<number, Buffer>();
  let checksum0 = headerChecksum0;
  let checksum1 = headerChecksum1;
  let committedFrameCount = 0;
  let dbSizeAfterCommit: number | undefined;
  let maxKnownPage = 0;
  let offset = WAL_HEADER_SIZE;
  while (offset + WAL_FRAME_HEADER_SIZE + pageSize <= wal.length) {
    const pageNumber = wal.readUInt32BE(offset);
    const frameDbSize = wal.readUInt32BE(offset + 4);
    if (pageNumber < 1) break;
    if (wal.readUInt32BE(offset + 8) !== salt1 || wal.readUInt32BE(offset + 12) !== salt2) break;
    // 校验和沿帧序列累加：帧头前 8 字节 + 页数据。不匹配即从此帧起全部作废。
    [checksum0, checksum1] = walChecksum(wal, offset, 8, checksum0, checksum1, bigEndian);
    [checksum0, checksum1] = walChecksum(wal, offset + WAL_FRAME_HEADER_SIZE, pageSize, checksum0, checksum1, bigEndian);
    if (checksum0 !== wal.readUInt32BE(offset + 16) || checksum1 !== wal.readUInt32BE(offset + 20)) break;

    pending.set(pageNumber, wal.subarray(offset + WAL_FRAME_HEADER_SIZE, offset + WAL_FRAME_HEADER_SIZE + pageSize));
    if (pageNumber > maxKnownPage) maxKnownPage = pageNumber;
    // dbSizeAfterCommit 非 0 即为提交帧，到此为止的事务整体生效。
    if (frameDbSize !== 0) {
      for (const [key, value] of pending) committed.set(key, value);
      pending.clear();
      committedFrameCount += 1;
      dbSizeAfterCommit = frameDbSize;
    }
    offset += WAL_FRAME_HEADER_SIZE + pageSize;
  }
  if (committedFrameCount === 0) return undefined;
  return { pageSize, committed, committedFrameCount, dbSizeAfterCommit, maxKnownPage };
}

/** SQLite WAL 校验和：按 8 字节一组累加两个 32 位状态（模 2^32）。 */
function walChecksum(data: Buffer, offset: number, length: number, s0: number, s1: number, bigEndian: boolean): [number, number] {
  for (let index = offset; index + 8 <= offset + length; index += 8) {
    const word0 = bigEndian ? data.readUInt32BE(index) : data.readUInt32LE(index);
    const word1 = bigEndian ? data.readUInt32BE(index + 4) : data.readUInt32LE(index + 4);
    s0 = (s0 + word0 + s1) >>> 0;
    s1 = (s1 + word1 + s0) >>> 0;
  }
  return [s0, s1];
}

function readDatabasePageSize(database: Buffer): number | undefined {
  if (database.length < 100) return undefined;
  const raw = database.readUInt16BE(16);
  return raw === 1 ? MAX_PAGE_SIZE : raw;
}
