import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

interface ReaderColumn {
  name: string;
  type: string;
  size: number;
  fixedLength: boolean;
  nullable: boolean;
  autoLong: boolean;
  autoUUID: boolean;
  precision?: number;
  scale?: number;
}

interface ReaderTable {
  getColumns(): ReaderColumn[];
  getData(): Record<string, unknown>[];
}

interface Reader {
  getPassword(): string | null;
  getTableNames(): string[];
  getTable(name: string): ReaderTable;
}

export interface AccessColumnMetadata {
  name: string;
  type: string;
  providerType: string;
  nullable: boolean;
  size: number;
  autoIncrement: boolean;
  fixedLength: boolean;
  editable: boolean;
  readOnly?: boolean;
  precision?: number;
  scale?: number;
}

export interface AccessTableMetadata {
  name: string;
  columns: string[];
  columnMetadata: AccessColumnMetadata[];
  columnTypes: Record<string, string>;
  rowCount: number;
  primaryKey: string[];
  editable: boolean;
  readonlyReason: string;
}

export interface AccessMutationResult {
  backupPath: string;
  rowCount: number;
  preMutationSha256: string;
  postMutationSha256: string;
  rowId?: number;
}

interface BridgeTable {
  name: string;
  columns: (Omit<AccessColumnMetadata, 'editable'>)[];
  primaryKey: string[];
  linked?: boolean;
  readOnly?: boolean;
}

interface BridgeResult {
  ok: boolean;
  error?: string;
  tables?: BridgeTable[];
  rowCount?: number;
}

interface Provider {
  executable: string;
  name: string;
}

interface SnapshotTable {
  columns: ReaderColumn[];
  rows: Record<string, unknown>[];
  tokens: number[];
}

interface Snapshot {
  sha256: string;
  encrypted: boolean;
  tables: Map<string, SnapshotTable>;
}

interface Mutation {
  kind: 'create' | 'update' | 'delete';
  rowId?: number;
  where?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

const scalarTypes = new Set(['boolean', 'byte', 'integer', 'long', 'currency', 'float', 'double', 'datetime', 'text', 'memo', 'repid', 'numeric', 'bigint']);
const bridgePath = path.resolve(__dirname, '../../tools/AccessBridge/access-bridge.ps1');
const MAX_BRIDGE_BYTES = 32 * 1024 * 1024;

/** The numeric row ID is a session token, never an Access row number or SQL predicate. */
export class AccessDatabaseSession {
  public metadata: AccessTableMetadata[] = [];
  public readonlyReason = '';
  private snapshot: Snapshot | undefined;
  private provider: Provider | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextToken = 1;
  private generation = 0;
  private disposed = false;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async initialize(): Promise<AccessTableMetadata[]> {
    return this.enqueue(() => this.initializeInternal());
  }

  async loadRows(tableName: string): Promise<Record<string, unknown>[]> {
    return this.enqueue(async () => {
      await this.initializeInternal();
      this.assertSourceUnchanged();
      const table = this.getTable(tableName);
      return table.rows.map((row, index) => {
        const result: Record<string, unknown> = Object.create(null);
        for (const column of table.columns) result[column.name] = displayValue(row[column.name]);
        result.__booRowId = table.tokens[index];
        return result;
      });
    });
  }

  async createRow(tableName: string, values: Record<string, unknown>): Promise<AccessMutationResult> {
    return this.enqueue(async () => {
      const meta = await this.writableTable(tableName);
      const normalized = normalizeValues(meta, values);
      if (Object.keys(normalized).length === 0) throw new Error('没有可新增的字段');
      return this.mutate(meta, [{ kind: 'create', values: normalized, rowId: this.nextToken++ }]);
    });
  }

  async updateRow(tableName: string, rowId: unknown, values: Record<string, unknown>): Promise<AccessMutationResult> {
    return this.updateRows(tableName, [{ rowId, values }]);
  }

  async updateRows(tableName: string, updates: { rowId: unknown; values: Record<string, unknown> }[]): Promise<AccessMutationResult> {
    return this.enqueue(async () => {
      const meta = await this.writableTable(tableName);
      if (!Array.isArray(updates) || updates.length === 0 || updates.length > 200) throw new Error('单次需要修改 1 至 200 行记录');
      const seen = new Set<number>();
      let cellCount = 0;
      const operations: Mutation[] = updates.map(update => {
        const token = normalizeToken(update.rowId);
        if (seen.has(token)) throw new Error('批量修改中包含重复记录');
        seen.add(token);
        const values = normalizeValues(meta, update.values);
        if (Object.keys(values).length === 0) throw new Error('没有可修改的字段');
        cellCount += Object.keys(values).length;
        return { kind: 'update', rowId: token, where: this.rowWhere(meta, token), values };
      });
      if (cellCount > 20000) throw new Error('单次最多修改 20000 个单元格');
      return this.mutate(meta, operations);
    });
  }

  async deleteRow(tableName: string, rowId: unknown): Promise<AccessMutationResult> {
    return this.enqueue(async () => {
      const meta = await this.writableTable(tableName);
      const token = normalizeToken(rowId);
      return this.mutate(meta, [{ kind: 'delete', rowId: token, where: this.rowWhere(meta, token) }]);
    });
  }

  async restoreBackup(backupPath: string, expectedSourceSha256: string, expectedBackupSha256: string): Promise<string> {
    return this.enqueue(async () => {
      await this.initializeInternal();
      if (!this.provider) throw new Error(this.readonlyReason || '缺少 MDB 写入 Provider，无法安全撤销');
      if (!/^[0-9a-f]{64}$/i.test(expectedSourceSha256) || fileSha256(this.filePath) !== expectedSourceSha256) throw new Error('MDB 已被其他程序修改，为避免覆盖外部数据，本次撤销已取消');
      const directory = path.join(path.dirname(this.filePath), 'boo-database-backups');
      const resolvedBackup = path.resolve(backupPath);
      if (path.dirname(resolvedBackup) !== directory || !path.basename(resolvedBackup).startsWith(`${path.basename(this.filePath)}.`) || !resolvedBackup.endsWith('.bak')) throw new Error('MDB 备份路径无效');
      if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(resolvedBackup).isFile() || fs.lstatSync(resolvedBackup).isSymbolicLink()) throw new Error('MDB 备份必须是本数据库备份目录中的普通文件');
      const backup = readSnapshot(resolvedBackup);
      if (!/^[0-9a-f]{64}$/i.test(expectedBackupSha256) || backup.sha256 !== expectedBackupSha256) throw new Error('MDB 撤销备份已经被修改，为避免恢复错误数据，本次撤销已取消');
      if (backup.encrypted) throw new Error('无法撤销到受密码保护的 MDB');
      const generation = this.generation;
      const candidatePath = path.join(path.dirname(this.filePath), `.boo-access-${process.pid}-${crypto.randomBytes(12).toString('hex')}.mdb`);
      try {
        fs.copyFileSync(resolvedBackup, candidatePath, fs.constants.COPYFILE_EXCL);
        const candidate = readSnapshot(candidatePath);
        if (candidate.sha256 !== backup.sha256 || candidate.tables.size !== backup.tables.size) throw new Error('MDB 撤销候选未通过独立回读校验');
        for (const [name, table] of backup.tables) {
          const restored = candidate.tables.get(name);
          if (!restored || JSON.stringify(table.columns) !== JSON.stringify(restored.columns) || rowSet(table.rows) !== rowSet(restored.rows)) throw new Error('MDB 撤销候选未通过完整数据核验');
        }
        if (generation !== this.generation) throw new Error('MDB 会话已刷新，已取消撤销');
        const safetyBackup = makeBackupPath(this.filePath);
        await runBridge(this.provider, { action: 'replace', sourcePath: this.filePath, candidatePath, expectedSha256: expectedSourceSha256, expectedCandidateSha256: backup.sha256, backupPath: safetyBackup });
        this.reset();
        return safetyBackup;
      } finally {
        try { fs.unlinkSync(candidatePath); } catch { /* Replacement consumes the verified candidate. */ }
      }
    });
  }

  /** Explicit refresh/undo invalidates every old token, including tokens retained by old pages. */
  reset(): void {
    this.generation++;
    this.snapshot = undefined;
    this.provider = undefined;
    this.metadata = [];
    this.readonlyReason = '';
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const execute = (): Promise<T> => {
      if (this.disposed) throw new Error('MDB 数据库会话已关闭');
      if (generation !== this.generation) throw new Error('MDB 会话已刷新，已取消旧请求，请重新操作');
      return action();
    };
    const result = this.queue.then(execute, execute);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async initializeInternal(): Promise<AccessTableMetadata[]> {
    if (this.snapshot) return this.metadata;
    const generation = this.generation;
    validateSourcePath(this.filePath);
    const snapshot = readSnapshot(this.filePath);
    for (const table of snapshot.tables.values()) table.tokens = table.rows.map(() => this.nextToken++);
    let bridgeTables: BridgeTable[] = [];
    let provider: Provider | undefined;
    let reason = '';
    const errors: string[] = [];
    if (snapshot.encrypted) reason = '受密码保护或加密的 MDB 暂不支持编辑';
    else if (process.platform !== 'win32') reason = 'MDB 编辑需要 Windows Jet 或 ACE 数据库组件；当前仍可只读浏览';
    else if (!fs.existsSync(bridgePath)) reason = '缺少 MDB 写入桥接程序，当前仍可只读浏览';
    else {
      for (const candidate of providerCandidates()) {
        try {
          await runBridge(candidate, { action: 'probe' });
          const result = await runBridge(candidate, { action: 'inspect', filePath: this.filePath });
          if (!validBridgeTables(result.tables)) throw new Error('Provider 未返回有效且完整的表结构');
          bridgeTables = result.tables;
          provider = candidate;
          break;
        } catch (error) { errors.push(`${candidate.name}: ${errorMessage(error)}`); }
      }
      if (!provider) reason = `没有可用的 MDB 写入 Provider，当前仍可只读浏览。${errors.join('；')}`;
    }
    if (generation !== this.generation) throw new Error('MDB 会话已刷新，请重新打开数据表');
    if (fileSha256(this.filePath) !== snapshot.sha256) throw new Error('MDB 在读取期间被其他程序修改，请刷新数据库后重试');
    this.provider = provider;
    this.readonlyReason = reason;
    this.snapshot = snapshot;
    this.metadata = [...snapshot.tables].map(([name, table]) => makeMetadata(name, table, bridgeTables.find(item => item.name === name), reason));
    return this.metadata;
  }

  private getTable(name: string): SnapshotTable {
    const table = this.snapshot?.tables.get(name);
    if (!table) throw new Error('MDB 数据表不存在或已刷新');
    return table;
  }

  private assertSourceUnchanged(): void {
    if (!this.snapshot || fileSha256(this.filePath) !== this.snapshot.sha256) throw new Error('MDB 已被其他程序修改，请刷新或重新打开数据库');
  }

  private async writableTable(name: string): Promise<AccessTableMetadata> {
    await this.initializeInternal();
    const metadata = this.metadata.find(table => table.name === name);
    if (!metadata) throw new Error('MDB 数据表不存在或已刷新');
    if (!metadata.editable || !this.provider) throw new Error(metadata.readonlyReason || this.readonlyReason || 'MDB 数据表不支持安全编辑');
    if (fileSha256(this.filePath) !== this.snapshot?.sha256) throw new Error('MDB 已被其他程序修改，为避免修改错误记录，请刷新或重新打开数据库');
    return metadata;
  }

  private rowWhere(meta: AccessTableMetadata, token: number): Record<string, unknown> {
    const table = this.getTable(meta.name);
    const index = table.tokens.indexOf(token);
    if (index < 0) throw new Error('MDB 记录身份已失效，请刷新或重新打开数据库');
    const row = table.rows[index];
    const names = meta.primaryKey.length ? meta.primaryKey : meta.columns;
    const where: Record<string, unknown> = Object.create(null);
    for (const name of names) where[name] = wireValue(row[name]);
    return where;
  }

  private async mutate(meta: AccessTableMetadata, operations: Mutation[]): Promise<AccessMutationResult> {
    const before = this.snapshot;
    const provider = this.provider;
    if (!before || !provider) throw new Error('MDB 编辑会话尚未初始化');
    const generation = this.generation;
    const candidatePath = path.join(path.dirname(this.filePath), `.boo-access-${process.pid}-${crypto.randomBytes(12).toString('hex')}.mdb`);
    let backupPath = '';
    try {
      fs.copyFileSync(this.filePath, candidatePath, fs.constants.COPYFILE_EXCL);
      if (fileSha256(candidatePath) !== before.sha256) throw new Error('MDB 源文件在复制期间发生变化，请刷新后重试');
      const result = await runBridge(provider, { action: 'mutate', filePath: candidatePath, tableName: meta.name, operations: operations.map(({ rowId: _rowId, ...operation }) => operation) });
      const after = readSnapshot(candidatePath);
      const rowId = verifyCandidate(before, after, meta, operations);
      if (result.rowCount !== after.tables.get(meta.name)?.rows.length) throw new Error('MDB 保存后的记录数与 Provider 报告不一致');
      if (generation !== this.generation) throw new Error('MDB 会话已刷新，已取消保存');
      if (fileSha256(this.filePath) !== before.sha256) throw new Error('MDB 已被其他程序修改，为避免覆盖外部数据，本次保存已取消');
      backupPath = makeBackupPath(this.filePath);
      await runBridge(provider, { action: 'replace', sourcePath: this.filePath, candidatePath, expectedSha256: before.sha256, expectedCandidateSha256: after.sha256, backupPath });
      // The verified snapshot belongs to the bytes just committed. Never silently reread and remap old tokens.
      this.snapshot = after;
      for (const item of this.metadata) {
        const table = after.tables.get(item.name);
        if (table) {
          item.rowCount = table.rows.length;
          const reason = identityReadOnlyReason(table, item);
          if (reason) { item.editable = false; item.readonlyReason = reason; }
        }
      }
      return { backupPath, rowCount: after.tables.get(meta.name)!.rows.length, preMutationSha256: before.sha256, postMutationSha256: after.sha256, ...(rowId === undefined ? {} : { rowId }) };
    } finally {
      try { fs.unlinkSync(candidatePath); } catch { /* A successful atomic replacement consumed it. */ }
    }
  }
}

function providerCandidates(): Provider[] {
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const native = path.join(windows, process.arch === 'ia32' && process.env.PROCESSOR_ARCHITEW6432 ? 'Sysnative' : 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const x86 = path.join(windows, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return [
    { executable: native, name: 'Microsoft.ACE.OLEDB.16.0' },
    { executable: native, name: 'Microsoft.ACE.OLEDB.12.0' },
    { executable: x86, name: 'Microsoft.Jet.OLEDB.4.0' },
    { executable: x86, name: 'Microsoft.ACE.OLEDB.16.0' },
    { executable: x86, name: 'Microsoft.ACE.OLEDB.12.0' },
    { executable: native, name: 'Microsoft.Jet.OLEDB.4.0' },
  ].filter(item => fs.existsSync(item.executable));
}

function runBridge(provider: Provider, request: Record<string, unknown>): Promise<BridgeResult> {
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload, 'utf8') > MAX_BRIDGE_BYTES) return Promise.reject(new Error('MDB 单次修改内容超过安全上限'));
  return new Promise((resolve, reject) => {
    const providerKey = provider.name === 'Microsoft.Jet.OLEDB.4.0' ? 'Jet4' : provider.name === 'Microsoft.ACE.OLEDB.12.0' ? 'ACE12' : 'ACE16';
    const child = spawn(provider.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridgePath, '-Provider', providerKey], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (error?: Error, result?: BridgeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('MDB 写入组件在 60 秒内没有响应，操作已取消')); }, 60000);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MAX_BRIDGE_BYTES) { child.kill(); finish(new Error('MDB 写入组件输出超过安全上限，操作已取消')); }
      else target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(output, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(errors, chunk));
    child.on('error', error => finish(new Error(`MDB 写入组件启动失败: ${error.message}`)));
    child.stdin.on('error', error => finish(new Error(`MDB 请求传输失败: ${error.message}`)));
    child.on('close', code => {
      if (done) return;
      const text = Buffer.concat(output).toString('utf8').replace(/^\uFEFF/, '').trim();
      let result: BridgeResult;
      try {
        result = JSON.parse(text) as BridgeResult;
        if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw new Error('Invalid bridge envelope');
      }
      catch { finish(new Error(`MDB 写入组件返回无效响应 (退出码 ${code}): ${Buffer.concat(errors).toString('utf8').slice(0, 2000) || text.slice(0, 2000)}`)); return; }
      if (code !== 0 || result.ok !== true) finish(new Error(`MDB 操作失败: ${String(result.error || Buffer.concat(errors).toString('utf8') || `退出码 ${code}`).slice(0, 3000)}`));
      else finish(undefined, result);
    });
    child.stdin.end(payload, 'utf8');
  });
}

function readSnapshot(filePath: string): Snapshot {
  const bytes = fs.readFileSync(filePath);
  const module = require('mdb-reader') as { default?: new (buffer: Buffer) => Reader } | (new (buffer: Buffer) => Reader);
  const MDBReader = typeof module === 'function' ? module : module.default;
  if (!MDBReader) throw new Error('MDB 读取组件初始化失败');
  const reader = new MDBReader(bytes);
  const tables = new Map<string, SnapshotTable>();
  for (const name of reader.getTableNames()) {
    if (name === '__proto__' || name === '__booRowId') throw new Error('MDB 包含保留表名，无法安全读取');
    const table = reader.getTable(name);
    const columns = table.getColumns();
    if (columns.some(column => column.name === '__booRowId')) throw new Error('MDB 包含保留字段 __booRowId，无法建立安全记录身份');
    const rows = table.getData();
    tables.set(name, { columns, rows, tokens: [] });
  }
  return { sha256: hash(bytes), encrypted: Boolean(reader.getPassword()), tables };
}

function makeMetadata(name: string, table: SnapshotTable, bridge: BridgeTable | undefined, reason: string): AccessTableMetadata {
  const columnMetadata: AccessColumnMetadata[] = table.columns.map(column => {
    const provider = bridge?.columns?.find(item => item.name === column.name);
    return {
      name: column.name,
      type: column.type,
      providerType: provider?.providerType || '',
      nullable: provider ? provider.nullable && column.nullable : column.nullable,
      size: column.type === 'text' ? (provider?.size || Math.floor(column.size / 2)) : column.size,
      autoIncrement: column.autoLong || column.autoUUID || provider?.autoIncrement === true,
      fixedLength: column.fixedLength || provider?.fixedLength === true,
      editable: scalarTypes.has(column.type) && !column.autoLong && !column.autoUUID && provider?.autoIncrement !== true && provider?.readOnly !== true,
      readOnly: provider?.readOnly === true,
      precision: column.precision,
      scale: column.scale,
    };
  });
  const meta: AccessTableMetadata = {
    name,
    columns: table.columns.map(column => column.name),
    columnMetadata,
    columnTypes: Object.fromEntries(table.columns.map(column => [column.name, column.type.toUpperCase()])),
    rowCount: table.rows.length,
    primaryKey: Array.isArray(bridge?.primaryKey) ? [...bridge.primaryKey] : [],
    editable: false,
    readonlyReason: reason,
  };
  if (!meta.readonlyReason) {
    if (!bridge || bridge.linked || bridge.readOnly) meta.readonlyReason = '链接表、系统表或无法确认本地结构的 MDB 表仅支持读取';
    else if (!Array.isArray(bridge.columns) || bridge.columns.length !== table.columns.length || table.columns.some(column => !bridge.columns.some(item => item.name === column.name && item.type === column.type))) meta.readonlyReason = 'MDB 两个读取组件的字段结构不一致，无法安全编辑';
    else meta.readonlyReason = identityReadOnlyReason(table, meta);
  }
  meta.editable = !meta.readonlyReason;
  return meta;
}

function identityReadOnlyReason(table: SnapshotTable, meta: AccessTableMetadata): string {
  const key = meta.primaryKey.length ? meta.primaryKey : meta.columns;
  if (key.length === 0 || key.some(name => !meta.columnMetadata.some(column => column.name === name && scalarTypes.has(column.type)))) return '数据表没有可安全比较的唯一记录身份，暂仅支持读取';
  const signatures = new Set<string>();
  for (const row of table.rows) {
    if (meta.primaryKey.length && key.some(name => row[name] === null || row[name] === undefined)) return 'MDB 主键包含空值，无法安全定位记录';
    const signature = signatureFor(row, meta, key);
    if (signatures.has(signature)) return '数据表存在重复记录身份，无法安全定位单条记录，暂仅支持读取';
    signatures.add(signature);
  }
  return '';
}

function validBridgeTables(value: unknown): value is BridgeTable[] {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  for (const table of value as BridgeTable[]) {
    if (!table || typeof table !== 'object' || typeof table.name !== 'string' || !table.name || names.has(table.name) || typeof table.linked !== 'boolean' || typeof table.readOnly !== 'boolean' || !Array.isArray(table.columns) || !Array.isArray(table.primaryKey)) return false;
    names.add(table.name);
    const columns = new Set<string>();
    for (const column of table.columns) {
      if (!column || typeof column.name !== 'string' || !column.name || columns.has(column.name) || typeof column.type !== 'string' || typeof column.providerType !== 'string' || typeof column.nullable !== 'boolean' || typeof column.autoIncrement !== 'boolean' || typeof column.fixedLength !== 'boolean' || typeof column.readOnly !== 'boolean' || !Number.isSafeInteger(column.size) || column.size < 0) return false;
      columns.add(column.name);
    }
    if (new Set(table.primaryKey).size !== table.primaryKey.length || table.primaryKey.some(key => typeof key !== 'string' || !columns.has(key))) return false;
  }
  return true;
}

function normalizeValues(meta: AccessTableMetadata, values: Record<string, unknown>): Record<string, unknown> {
  if (!values || typeof values !== 'object' || Array.isArray(values) || ![Object.prototype, null].includes(Object.getPrototypeOf(values))) throw new Error('MDB 记录内容格式无效');
  const result: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(values)) {
    const column = meta.columnMetadata.find(item => item.name === name);
    if (!column) throw new Error(`MDB 字段不存在: ${name}`);
    if (!column.editable) throw new Error(`字段 ${name} 是自动编号或不支持写入的类型，不能修改`);
    result[name] = normalizeValue(column, value);
  }
  return result;
}

function normalizeValue(column: AccessColumnMetadata, value: unknown): unknown {
  const fail = (detail: string): never => { throw new Error(`字段 ${column.name}: ${detail}`); };
  if (value === null) return column.nullable ? null : fail('不允许空值');
  if (value === undefined || (typeof value === 'object' && !(value instanceof Date))) return fail('不支持对象、数组或未定义值');
  if (column.type === 'text' || column.type === 'memo' || column.type === 'repid') {
    if (typeof value !== 'string' || value.includes('\0')) return fail('需要有效文本');
    if (column.type === 'text' && value.length > column.size) return fail(`文本长度超过 ${column.size}`);
    if (column.type === 'memo' && value.length > 1000000) return fail('长文本超过单次编辑上限');
    if (column.type === 'repid' && !/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(value)) return fail('需要有效 GUID');
    return value;
  }
  if (column.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 0 || value === '0' || value === 'false' || value === 'FALSE') return false;
    if (value === 1 || value === -1 || value === '1' || value === '-1' || value === 'true' || value === 'TRUE') return true;
    return fail('需要布尔值 true/false 或 0/1');
  }
  if (column.type === 'datetime') {
    if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))) return fail('需要带 UTC 时区的 ISO 日期时间');
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 100 || date.getUTCFullYear() > 9999) return fail('日期时间无效或超出 Access 范围');
    if (typeof value === 'string') {
      const expected = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction || '').padEnd(3, '0')}Z`);
      if (date.toISOString() !== expected) return fail('日期时间包含无效的日历日期');
    }
    return date.toISOString();
  }
  if (column.type === 'currency' || column.type === 'numeric' || column.type === 'bigint') {
    // Numbers with decimals may already have lost precision before they reach the backend.
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return fail('精确数值请以十进制字符串输入');
    if (typeof value !== 'string' && typeof value !== 'number') return fail('需要十进制数字');
    const text = String(value).trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) return fail('不接受指数形式或无效的十进制数字');
    const scale = column.type === 'currency' ? 4 : column.type === 'bigint' ? 0 : (column.scale ?? 0);
    const fractional = match[3] || '';
    if (fractional.length > scale) return fail(`最多允许 ${scale} 位小数`);
    const digits = `${match[2]}${fractional.padEnd(scale, '0')}`.replace(/^0+(?=\d)/, '');
    if (column.type === 'currency' && BigInt(digits) > (match[1] ? 9223372036854775808n : 9223372036854775807n)) return fail('货币数值超出 Access 范围');
    if (column.type === 'bigint' && BigInt(text) < -9223372036854775808n || column.type === 'bigint' && BigInt(text) > 9223372036854775807n) return fail('整数超出 64 位范围');
    if (column.type === 'numeric' && digits.length > (column.precision ?? 28)) return fail('数值超出字段精度');
    return normalizeDecimal(text);
  }
  if (typeof value !== 'number' && typeof value !== 'string') return fail('需要数字');
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return fail('数字格式无效');
  const number = Number(value);
  if (!Number.isFinite(number)) return fail('不接受 NaN 或无穷大');
  const bounds: Record<string, [number, number]> = { byte: [0, 255], integer: [-32768, 32767], long: [-2147483648, 2147483647] };
  if (bounds[column.type] && (!Number.isInteger(number) || number < bounds[column.type][0] || number > bounds[column.type][1])) return fail('整数超出字段范围');
  if (column.type === 'float' && Math.fround(number) !== number) return fail('数值不能由单精度字段精确保留');
  return number;
}

function verifyCandidate(before: Snapshot, after: Snapshot, meta: AccessTableMetadata, operations: Mutation[]): number | undefined {
  if (before.encrypted !== after.encrypted || before.tables.size !== after.tables.size) throw new Error('MDB 保存后数据库结构发生非预期变化');
  for (const [name, original] of before.tables) {
    const candidate = after.tables.get(name);
    if (!candidate || JSON.stringify(original.columns) !== JSON.stringify(candidate.columns)) throw new Error(`MDB 保存后字段结构发生变化: ${name}`);
    if (name !== meta.name) {
      if (rowSet(original.rows) !== rowSet(candidate.rows)) throw new Error(`MDB 保存影响了其他数据表: ${name}`);
      candidate.tokens = [...original.tokens];
      // Provider updates can reorder physical rows; tokens still follow logical records.
      remapTokens(original, candidate);
    }
  }
  const original = before.tables.get(meta.name)!;
  const candidate = after.tables.get(meta.name)!;
  const expected = original.rows.map((row, index) => ({ row, token: original.tokens[index] }));
  let changedToken: number | undefined;
  let created: Mutation | undefined;
  for (const operation of operations) {
    changedToken = operation.rowId;
    if (operation.kind === 'create') { created = operation; continue; }
    const index = expected.findIndex(item => item.token === operation.rowId);
    if (index < 0) throw new Error('MDB 待修改记录身份已经失效');
    if (operation.kind === 'delete') expected.splice(index, 1);
    else expected[index] = { row: { ...expected[index].row, ...operation.values }, token: expected[index].token };
  }
  if (candidate.rows.length !== expected.length + (created ? 1 : 0)) throw new Error('MDB 保存后的记录数量不符合预期');
  const available = candidate.rows.map((row, index) => ({ row, index, signature: signatureFor(row, meta) }));
  candidate.tokens = [];
  for (const item of expected) {
    const signature = signatureFor(item.row, meta);
    const index = available.findIndex(row => row.signature === signature);
    if (index < 0) throw new Error('MDB 保存后字段值未能通过独立回读核验，源文件未修改');
    candidate.tokens[available[index].index] = item.token;
    available.splice(index, 1);
  }
  if (created) {
    if (available.length !== 1 || !Object.entries(created.values || {}).every(([name, value]) => canonicalValue(available[0].row[name], meta.columnMetadata.find(column => column.name === name)) === canonicalValue(value, meta.columnMetadata.find(column => column.name === name)))) throw new Error('MDB 新增记录未能通过独立回读核验，源文件未修改');
    candidate.tokens[available[0].index] = created.rowId!;
  }
  if (identityReadOnlyReason(candidate, meta)) throw new Error('修改结果产生了重复或不安全的记录身份，源文件未修改');
  return operations.length === 1 && operations[0].kind !== 'delete' ? changedToken : undefined;
}

function remapTokens(original: SnapshotTable, candidate: SnapshotTable): void {
  const tokens = new Map<string, number[]>();
  original.rows.forEach((row, index) => { const key = JSON.stringify(stableValue(row)); const group = tokens.get(key) || []; group.push(original.tokens[index]); tokens.set(key, group); });
  candidate.tokens = candidate.rows.map(row => tokens.get(JSON.stringify(stableValue(row)))!.shift()!);
}

function signatureFor(row: Record<string, unknown>, meta: AccessTableMetadata, names = meta.columns): string {
  return JSON.stringify(names.map(name => [name, canonicalValue(row[name], meta.columnMetadata.find(column => column.name === name))]));
}

function canonicalValue(value: unknown, column?: AccessColumnMetadata): string {
  if (value === null || value === undefined) return 'null';
  if (column?.type === 'datetime') return `date:${value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()}`;
  if (column?.type === 'currency' || column?.type === 'numeric' || column?.type === 'bigint') return `decimal:${normalizeDecimal(String(value))}`;
  if (column?.type === 'text' && column.fixedLength) return `text:${String(value).replace(/ +$/, '')}`;
  if (column?.type === 'repid') return `guid:${String(value).replace(/[{}]/g, '').toLowerCase()}`;
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { binary: value.toString('base64') };
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(name => [name, stableValue((value as Record<string, unknown>)[name])]));
  return value;
}

function rowSet(rows: Record<string, unknown>[]): string { return hash(Buffer.from(rows.map(row => JSON.stringify(stableValue(row))).sort().join('\n'))); }
function hash(bytes: Buffer): string { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function fileSha256(filePath: string): string { return hash(fs.readFileSync(filePath)); }
function makeBackupPath(filePath: string): string {
  const directory = path.join(path.dirname(filePath), 'boo-database-backups');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('MDB 备份目录不能是符号链接');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(directory, `${path.basename(filePath)}.${stamp}.${crypto.randomBytes(8).toString('hex')}.bak`);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function normalizeDecimal(value: string): string {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
  const normalized = `${whole.replace(/^0+(?=\d)/, '')}${fraction.replace(/0+$/, '') ? `.${fraction.replace(/0+$/, '')}` : ''}`;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}
function wireValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}
function displayValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return `[二进制 ${value.length} 字节，只读]`;
  if (Array.isArray(value)) return '[复杂字段，只读]';
  return wireValue(value);
}
function normalizeToken(value: unknown): number {
  const token = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(token) || token < 1) throw new Error('MDB 记录身份无效');
  return token;
}
function validateSourcePath(filePath: string): void {
  if (!/\.mdb$/i.test(filePath) || path.basename(filePath).startsWith('.boo-access-')) throw new Error('需要选择原始 MDB 数据库文件');
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('MDB 数据源必须是普通文件');
}
