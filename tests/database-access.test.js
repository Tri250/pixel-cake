const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helperPath = path.join(__dirname, 'helpers', 'access-fixture.ps1');
const runtimeRoot = path.resolve(process.env.BOO_DATABASE_RUNTIME_ROOT || path.join(__dirname, '..'));
const MDBModule = require('mdb-reader');
const MDBReader = typeof MDBModule === 'function' ? MDBModule : MDBModule.default;
const { DatabaseBrowserSession } = require(path.join(runtimeRoot, 'out', 'utils', 'database-browser'));
const { AccessDatabaseSession } = require(path.join(runtimeRoot, 'out', 'utils', 'access-database'));

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixtureCommand(runtime, filePath, action = 'create') {
  const result = spawnSync(runtime.exe, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helperPath, '-FilePath', filePath, '-Provider', runtime.provider, '-Action', action,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Synthetic Access fixture failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

function chooseRuntime(tempDir) {
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    { exe: path.join(windowsRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), provider: 'Microsoft.Jet.OLEDB.4.0' },
    { exe: path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), provider: 'Microsoft.ACE.OLEDB.16.0' },
    { exe: path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), provider: 'Microsoft.ACE.OLEDB.12.0' },
  ];
  const unavailable = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!fs.existsSync(candidate.exe)) {
      unavailable.push(`${candidate.provider}: PowerShell architecture unavailable`);
      continue;
    }
    const seedPath = path.join(tempDir, `synthetic-${index}.mdb`);
    const result = fixtureCommand(candidate, seedPath);
    if (result.available) return { ...candidate, seedPath, architecture: result.architecture };
    unavailable.push(result.reason);
  }
  console.log(`database-access.test.js: SKIP (no installed Jet/ACE provider; ${unavailable.join('; ')})`);
  return undefined;
}

function readTables(filePath) {
  const reader = new MDBReader(fs.readFileSync(filePath));
  return Object.fromEntries(reader.getTableNames().map(name => {
    const table = reader.getTable(name);
    return [name, { columns: table.getColumnNames(), rows: table.getData() }];
  }));
}

function findRow(filePath, tableName, predicate) {
  return readTables(filePath)[tableName].rows.find(predicate);
}

function request(tableId, extra = {}) {
  return { tableId, offset: 0, limit: 100, query: '', sortColumn: '', sortDirection: 'asc', ...extra };
}

async function page(session, table, extra = {}) {
  return session.loadPage(request(table.id, extra));
}

function tableNamed(catalog, name) {
  const table = catalog.tables.find(entry => entry.name === name && entry.kind === 'access');
  assert.ok(table, `Access catalog must contain ${name}`);
  return table;
}

async function basicWrites(session, filePath, catalog) {
  const table = tableNamed(catalog, 'StdItems');
  assert.equal(table.editable, true, 'a supported local MDB table must be editable');
  assert.equal(table.schemaEditable, false, 'MDB writes must not expose schema changes');
  assert.ok(table.columnTypes.Price, 'MDB catalog must publish field types');
  const originalHash = sha256(filePath);
  const original = readTables(filePath);
  let result = await page(session, table, { sortColumn: 'Id' });
  assert.equal(result.total, 3);
  assert.equal(result.rows.length, 3);
  for (const row of result.rows) assert.ok(Number.isSafeInteger(row.__booRowId) && row.__booRowId > 0);
  const originalToken = result.rows[0].__booRowId;

  const literal = "中文 O'Brien'; DROP TABLE StdItems; --";
  const memo = '中文长备注\r\n'.repeat(180);
  const updated = await session.updateRow(table.id, result.rows[0].__booRowId, {
    Name: literal, Price: 999, Enabled: false, Note: memo, Optional: 55,
  });
  assert.equal(updated.operation, 'update');
  assert.equal(sha256(updated.backupPath), originalHash, 'pre-write backup must be the exact original MDB');
  assert.equal(path.basename(path.dirname(updated.backupPath)), 'boo-database-backups');
  let independent = findRow(filePath, 'StdItems', row => row.Id === 1);
  assert.equal(independent.Name, literal, 'SQL-looking strings must remain literal Unicode text');
  assert.equal(independent.Price, 999);
  assert.equal(independent.Enabled, false);
  assert.equal(independent.Note, memo, 'Memo values longer than 255 characters must survive reopening');
  assert.equal(independent.Optional, 55);

  result = await page(session, table, { sortColumn: 'Id' });
  const batchHash = sha256(filePath);
  const batch = await session.updateRows(table.id, [
    { rowId: result.rows[0].__booRowId, values: { Price: 111, Optional: null } },
    { rowId: result.rows[1].__booRowId, values: { Price: 222, Enabled: true } },
  ]);
  assert.equal(sha256(batch.backupPath), batchHash, 'one rectangular write must create one exact restore point');
  independent = findRow(filePath, 'StdItems', row => row.Id === 1);
  assert.equal(independent.Price, 111);
  assert.equal(independent.Optional, null, 'NULL must remain NULL after a parameterized write');
  assert.equal(findRow(filePath, 'StdItems', row => row.Id === 2).Price, 222);

  const created = await session.createRow(table.id, {
    Id: 10, Name: "新增 O'Brien", Price: 77, Enabled: true, Note: '新记录', Optional: null,
    Created: '2026-10-20T12:34:56.000Z',
  });
  assert.equal(created.operation, 'create');
  assert.ok(fs.existsSync(created.backupPath));
  independent = findRow(filePath, 'StdItems', row => row.Id === 10);
  assert.ok(independent, 'created record must exist through an independent MDB reader');
  assert.equal(independent.Name, "新增 O'Brien");
  assert.equal(independent.Price, 77);
  assert.equal(independent.Optional, null);
  assert.equal(independent.Created.toISOString(), '2026-10-20T12:34:56.000Z');
  result = await page(session, table, { query: '10', searchColumn: 'Id', matchMode: 'exact' });
  assert.equal(result.total, 1);
  const deleted = await session.deleteRow(table.id, result.rows[0].__booRowId);
  assert.equal(deleted.operation, 'delete');
  assert.equal(findRow(filePath, 'StdItems', row => row.Id === 10), undefined);

  for (const operation of ['delete', 'create', 'update', 'update']) {
    const undone = await session.undoLastMutation();
    assert.equal(undone.revertedOperation, operation);
    assert.ok(fs.existsSync(undone.backupPath), 'undo must preserve the replaced MDB as a safety backup');
  }
  assert.equal(sha256(filePath), originalHash, 'undoing every edit must restore exact original MDB bytes');
  assert.deepEqual(readTables(filePath), original, 'all unedited records and OLE fields must survive edit and undo');
  await assert.rejects(session.undoLastMutation(), /没有可撤回/);
  await assert.rejects(session.updateRow(table.id, originalToken, { Price: 5 }), /行|不存在|失效|标识/);
  await assert.rejects(session.updateSchema(table.id, []), /Access|MDB|结构|只读|不支持/);
  assert.equal(sha256(filePath), originalHash, 'unsupported schema operations must leave MDB bytes untouched');
}

async function atomicFailures(session, filePath, catalog) {
  const table = tableNamed(catalog, 'StdItems');
  let result = await page(session, table, { sortColumn: 'Id' });
  const initialHash = sha256(filePath);
  const initial = readTables(filePath);
  await assert.rejects(session.updateRows(table.id, [
    { rowId: result.rows[0].__booRowId, values: { Price: 12345 } },
    { rowId: result.rows[1].__booRowId, values: { Id: 1 } },
  ]), /重复|唯一|约束|主键|失败|写|duplicate|index/i);
  assert.equal(sha256(filePath), initialHash, 'a mid-batch uniqueness error must not publish any changed bytes');
  assert.deepEqual(readTables(filePath), initial, 'failed batch must preserve every original record');

  result = await page(session, table, { sortColumn: 'Id' });
  await assert.rejects(session.deleteRow(table.id, result.rows[0].__booRowId), /约束|关联|关系|删除|失败|related|referential/i);
  assert.equal(sha256(filePath), initialHash, 'foreign-key rejection must preserve the original file');
  result = await page(session, table, { sortColumn: 'Id' });
  await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { Price: 2147483648 }), /范围|整数|失败|溢出|类型|数字|overflow/i);
  await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { Price: true }), /整数|数值|数字|类型|布尔/);
  await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { Price: 1.5 }), /整数|数值|数字|类型/);
  await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { Enabled: 'maybe' }), /布尔|类型|true|false|0|1/);
  await assert.rejects(session.updateRow(table.id, 999999999, { Price: 1 }), /行|不存在|失效|标识/);
  await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { ['Price] = 0 WHERE 1=1; --']: 1 }), /字段|列|不存在/);
  assert.equal(sha256(filePath), initialHash, 'invalid values, identifiers and row IDs must never publish a write');
}

async function preciseNumbers(session, filePath, catalog) {
  const table = tableNamed(catalog, 'PreciseNumbers');
  assert.equal(table.columnTypes.Amount, 'CURRENCY', 'the fixture must contain a physical Access Currency field');
  assert.equal(table.columnTypes.ExactValue, 'NUMERIC', 'the fixture must contain a physical Access DECIMAL(20,4) field');
  const reader = new MDBReader(fs.readFileSync(filePath));
  const numericColumn = reader.getTable('PreciseNumbers').getColumn('ExactValue');
  assert.equal(numericColumn.type, 'numeric');
  assert.equal(numericColumn.precision, 20);
  assert.equal(numericColumn.scale, 4);
  const originalHash = sha256(filePath);
  const original = readTables(filePath);
  let result = await page(session, table);
  const currency = '900719925474099.1001';
  const numeric = '9007199254740991.1001';
  await session.updateRow(table.id, result.rows[0].__booRowId, { Amount: currency, ExactValue: numeric });
  const independentlyRead = findRow(filePath, 'PreciseNumbers', row => row.Id === 1);
  assert.equal(independentlyRead.Amount, currency, 'Currency digits beyond binary floating-point precision must round-trip exactly');
  assert.equal(independentlyRead.ExactValue, numeric, 'DECIMAL(20,4) must retain every digit on independent reopening');
  result = await page(session, table);
  assert.equal(result.rows[0].Amount, currency);
  assert.equal(result.rows[0].ExactValue, numeric);
  const committedHash = sha256(filePath);
  for (const field of ['Amount', 'ExactValue']) {
    await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { [field]: 1.25 }), /精确|字符串|十进制/);
    await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { [field]: '1.00001' }), /小数|精度/);
  }
  await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { Amount: '922337203685477.5808' }), /范围|货币/);
  await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { ExactValue: '99999999999999999.0001' }), /精度|范围/);
  assert.equal(sha256(filePath), committedHash, 'rejected rounded or out-of-range inputs must not modify the source MDB');
  const undo = await session.undoLastMutation();
  assert.equal(undo.revertedOperation, 'update');
  assert.equal(sha256(filePath), originalHash, 'precise-number undo must restore the exact original MDB bytes');
  assert.deepEqual(readTables(filePath), original);
}

async function rowIdentity(session, filePath, catalog) {
  const noKey = tableNamed(catalog, 'NoKey');
  const originalHash = sha256(filePath);
  let result = await page(session, noKey);
  const unique = result.rows.find(row => row.Name === 'unique');
  assert.ok(unique && unique.__booRowId > 0, 'a unique complete-row identity must support tables without a primary key');
  await session.updateRow(noKey.id, unique.__booRowId, { Value: 44 });
  assert.equal(findRow(filePath, 'NoKey', row => row.Name === 'unique').Value, 44);
  await session.undoLastMutation();
  result = await page(session, noKey);
  const nullable = result.rows.find(row => row.Name === null);
  await session.updateRow(noKey.id, nullable.__booRowId, { Value: 55 });
  assert.equal(findRow(filePath, 'NoKey', row => row.Name === null).Value, 55, 'NULL identity members must use IS NULL predicates');
  await session.undoLastMutation();
  assert.equal(sha256(filePath), originalHash);

  const duplicates = tableNamed(catalog, 'Duplicates');
  result = await page(session, duplicates);
  await assert.rejects(session.updateRow(duplicates.id, result.rows[0].__booRowId, { Value: 99 }), /重复|唯一|定位|标识|只读/);
  assert.equal(sha256(filePath), originalHash, 'ambiguous duplicate rows must be rejected rather than edited together');

  const binary = tableNamed(catalog, 'BinaryKey');
  result = await page(session, binary);
  const payload = findRow(filePath, 'BinaryKey', row => row.Id === 1).Payload;
  await assert.rejects(session.updateRow(binary.id, result.rows[0].__booRowId, { Payload: 'replacement' }), /不支持|只读|二进制|字段|类型/);
  result = await page(session, binary);
  await session.updateRow(binary.id, result.rows[0].__booRowId, { Name: 'safe scalar edit' });
  assert.deepEqual(findRow(filePath, 'BinaryKey', row => row.Id === 1).Payload, payload, 'editing a scalar field must preserve unrelated binary bytes');
  await session.undoLastMutation();
  assert.equal(sha256(filePath), originalHash);
}

async function externalChanges(session, filePath, catalog, runtime) {
  const table = tableNamed(catalog, 'StdItems');
  const result = await page(session, table, { sortColumn: 'Id' });
  fixtureCommand(runtime, filePath, 'external');
  const externalHash = sha256(filePath);
  await assert.rejects(session.updateRow(table.id, result.rows[0].__booRowId, { Price: 2 }), /其他程序|外部|修改|失效/);
  assert.equal(sha256(filePath), externalHash);
  assert.equal(findRow(filePath, 'StdItems', row => row.Id === 1).Price, 54321);
}

async function externalUndo(session, filePath, catalog, runtime) {
  const table = tableNamed(catalog, 'StdItems');
  const result = await page(session, table, { sortColumn: 'Id' });
  await session.updateRow(table.id, result.rows[0].__booRowId, { Price: 99 });
  fixtureCommand(runtime, filePath, 'external');
  const externalHash = sha256(filePath);
  await assert.rejects(session.undoLastMutation(), /其他程序|外部|修改/);
  assert.equal(sha256(filePath), externalHash, 'refused undo must retain the external edit byte-for-byte');
  assert.equal(findRow(filePath, 'StdItems', row => row.Id === 1).Price, 54321);
}

async function tamperedBackup(session, filePath, catalog, runtime) {
  const table = tableNamed(catalog, 'StdItems');
  const result = await page(session, table, { sortColumn: 'Id' });
  const mutation = await session.updateRow(table.id, result.rows[0].__booRowId, { Price: 99 });
  const committedHash = sha256(filePath);
  const originalBackupHash = sha256(mutation.backupPath);
  const tamperedCopy = path.join(path.dirname(filePath), 'modified-backup.mdb');
  fs.copyFileSync(mutation.backupPath, tamperedCopy);
  fixtureCommand(runtime, tamperedCopy, 'external');
  fs.copyFileSync(tamperedCopy, mutation.backupPath);
  assert.notEqual(sha256(mutation.backupPath), originalBackupHash, 'control must actually modify the valid backup contents');
  await assert.rejects(session.undoLastMutation(), /备份|篡改|完整性|修改/);
  assert.equal(sha256(filePath), committedHash, 'a modified backup must never be restored over the committed database');
  assert.equal(findRow(filePath, 'StdItems', row => row.Id === 1).Price, 99);
}

function tamperedCandidate(tempDir, runtime) {
  const directory = path.join(tempDir, 'candidate-integrity');
  fs.mkdirSync(directory);
  const filePath = path.join(directory, 'original.mdb');
  const candidatePath = path.join(directory, '.boo-access-integrity-test.mdb');
  fs.copyFileSync(runtime.seedPath, filePath);
  fs.copyFileSync(runtime.seedPath, candidatePath);
  const sourceHash = sha256(filePath);
  const verifiedCandidateHash = sha256(candidatePath);
  fixtureCommand(runtime, candidatePath, 'external');
  assert.notEqual(sha256(candidatePath), verifiedCandidateHash);
  const backupPath = path.join(directory, 'boo-database-backups', 'original.mdb.integrity.bak');
  const bridge = path.join(runtimeRoot, 'tools', 'AccessBridge', 'access-bridge.ps1');
  const provider = runtime.provider.includes('Jet.') ? 'Jet4' : runtime.provider.includes('16.') ? 'ACE16' : 'ACE12';
  const result = spawnSync(runtime.exe, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridge, '-Provider', provider,
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    input: JSON.stringify({ action: 'replace', sourcePath: filePath, candidatePath,
      expectedSha256: sourceHash, expectedCandidateSha256: verifiedCandidateHash, backupPath }),
  });
  if (result.error) throw result.error;
  const response = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(response.ok, false, 'replacement must refuse a candidate changed after independent verification');
  assert.match(response.error, /candidate|verified|sha|hash|changed/i);
  assert.notEqual(result.status, 0);
  assert.equal(sha256(filePath), sourceHash);
  assert.equal(fs.existsSync(backupPath), false, 'a refused replacement must not publish a restore point as if it succeeded');
}

async function queuedLifecycle(tempDir, runtime) {
  for (const action of ['dispose', 'reset']) {
    const directory = path.join(tempDir, `queued-${action}`);
    fs.mkdirSync(directory);
    const filePath = path.join(directory, 'lifecycle.mdb');
    fs.copyFileSync(runtime.seedPath, filePath);
    const originalHash = sha256(filePath);
    const session = new AccessDatabaseSession(filePath);
    try {
      await session.initialize();
      const queued = session.createRow('StdItems', { Id: 10, Name: 'queued mutation', Price: 77, Enabled: true });
      session[action]();
      await assert.rejects(queued, /会话|关闭|刷新|取消|失效|disposed|reset/i,
        `an enqueued write must not start after immediate ${action}`);
      assert.equal(sha256(filePath), originalHash, `${action} must cancel queued writes before any source bytes change`);
      assert.equal(findRow(filePath, 'StdItems', row => row.Id === 10), undefined);
      if (action === 'dispose') {
        await assert.rejects(session.initialize(), /关闭|会话|disposed/i, 'dispose must be a permanent lifecycle boundary');
      } else {
        const metadata = await session.initialize();
        assert.ok(metadata.some(table => table.name === 'StdItems' && table.editable), 'reset must allow a subsequent fresh initialization');
        assert.equal((await session.loadRows('StdItems')).length, 3);
      }
      assert.equal(sha256(filePath), originalHash);
    } finally { session.dispose(); }
  }
}

async function tableIdentityAfterUndo(tempDir, runtime) {
  const directory = path.join(tempDir, 'table-identity');
  fs.mkdirSync(directory);
  const filePath = path.join(directory, 'z-original.mdb');
  fs.copyFileSync(runtime.seedPath, filePath);
  const originalHash = sha256(filePath);
  const session = new DatabaseBrowserSession(directory);
  let table;
  try {
    const catalog = await session.initialize();
    table = tableNamed(catalog, 'StdItems');
    const result = await page(session, table, { sortColumn: 'Id' });
    await session.updateRow(table.id, result.rows[0].__booRowId, { Price: 123 });

    const SQL = await require('sql.js')();
    const addedDatabase = new SQL.Database();
    addedDatabase.run('CREATE TABLE StdItems (Id INTEGER PRIMARY KEY, Name TEXT, Price INTEGER)');
    addedDatabase.run("INSERT INTO StdItems VALUES (1, 'separate new source', 9876)");
    const addedPath = path.join(directory, 'a-added.db');
    fs.writeFileSync(addedPath, Buffer.from(addedDatabase.export()));
    addedDatabase.close();
    const addedHash = sha256(addedPath);

    const undo = await session.undoLastMutation();
    assert.equal(undo.tableId, table.id, 'catalog refresh after undo must retain the exact original source table ID');
    const refreshed = await session.initialize();
    const sameTable = refreshed.tables.find(entry => entry.id === table.id);
    assert.equal(sameTable?.fileName, 'z-original.mdb', 'a newly added alphabetically earlier database must not steal an existing table ID');
    assert.equal(sameTable?.kind, 'access');
    assert.equal(sameTable?.name, 'StdItems');
    assert.equal(sha256(filePath), originalHash);
    assert.equal(sha256(addedPath), addedHash, 'undo must preserve the database added by another workflow');
    const rows = await page(session, sameTable, { sortColumn: 'Id' });
    assert.equal(rows.rows[0].Price, 10);
    const newTable = refreshed.tables.find(entry => entry.fileName === 'a-added.db');
    assert.ok(newTable && newTable.id !== table.id, 'different source files must always have different table IDs');
  } finally { session.dispose(); }

  const reopened = new DatabaseBrowserSession(directory);
  try {
    const catalog = await reopened.initialize();
    const newTable = tableNamed(catalog, 'StdItems');
    assert.notEqual(newTable.id, table.id, 'a new database session must not accept a previous source session table ID');
    await assert.rejects(reopened.loadPage(request(table.id)), /不存在|已|失效|无效|数据表/);
  } finally { reopened.dispose(); }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('database-access.test.js: SKIP (real Jet/ACE integration requires Windows)');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boo-access-edit-'));
  try {
    const runtime = chooseRuntime(tempDir);
    if (!runtime) return;
    console.log(`Access fixture: ${runtime.provider}, ${runtime.architecture}-bit PowerShell`);
    const checks = [basicWrites, atomicFailures, preciseNumbers, rowIdentity, externalChanges, externalUndo, tamperedBackup];
    for (const check of checks) {
      const directory = path.join(tempDir, check.name);
      fs.mkdirSync(directory);
      const filePath = path.join(directory, 'synthetic.mdb');
      fs.copyFileSync(runtime.seedPath, filePath);
      const originalHash = sha256(filePath);
      const session = new DatabaseBrowserSession(filePath);
      try {
        const catalog = await session.initialize();
        assert.equal(sha256(filePath), originalHash, 'catalog discovery must preserve the source MDB byte-for-byte');
        await check(session, filePath, catalog, runtime);
        console.log(`Access check: ${check.name} PASS`);
      } finally { session.dispose(); }
    }

    const mixedDirectory = path.join(tempDir, 'mixed-sources');
    fs.mkdirSync(mixedDirectory);
    fs.copyFileSync(runtime.seedPath, path.join(mixedDirectory, 'Access.mdb'));
    const SQL = await require('sql.js')();
    const sqlite = new SQL.Database();
    sqlite.run('CREATE TABLE Monster (Id INTEGER PRIMARY KEY, Name TEXT)');
    sqlite.run("INSERT INTO Monster VALUES (1, 'SQLite monster')");
    fs.writeFileSync(path.join(mixedDirectory, 'SQLite.db'), Buffer.from(sqlite.export()));
    sqlite.close();
    const mixed = new DatabaseBrowserSession(mixedDirectory);
    try {
      const catalog = await mixed.initialize();
      assert.ok(catalog.tables.some(table => table.kind === 'sqlite'));
      assert.ok(catalog.tables.some(table => table.kind === 'access'), 'an SQLite file must not hide MDB tables in the same directory');
      assert.match(catalog.dbType, /SQLite/);
      assert.match(catalog.dbType, /Access/);
    } finally { mixed.dispose(); }
    await tableIdentityAfterUndo(tempDir, runtime);
    console.log('Access check: tableIdentityAfterUndo PASS');
    tamperedCandidate(tempDir, runtime);
    console.log('Access check: tamperedCandidate PASS');
    await queuedLifecycle(tempDir, runtime);
    console.log('Access check: queuedLifecycle PASS');
    console.log('database-access.test.js: PASS (real providers, synthetic MDB only)');
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
