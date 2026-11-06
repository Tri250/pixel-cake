const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sqlite-wal');

// 与 SQLite 官方规范一致的 WAL 校验和（独立实现，用于构造测试帧）。
function walChecksum(data, offset, length, s0, s1, bigEndian) {
  for (let index = offset; index + 8 <= offset + length; index += 8) {
    const word0 = bigEndian ? data.readUInt32BE(index) : data.readUInt32LE(index);
    const word1 = bigEndian ? data.readUInt32BE(index + 4) : data.readUInt32LE(index + 4);
    s0 = (s0 + word0 + s1) >>> 0;
    s1 = (s1 + word1 + s0) >>> 0;
  }
  return [s0, s1];
}

function buildWal({ pageSize, frames, bigEndian = false, salt1, salt2, breakHeaderChecksum = false }) {
  // bigEndian 与 SQLite 语义一致：0x377f0683 → 大端字序，0x377f0682（默认）→ 小端字序。
  const header = Buffer.alloc(32);
  header.writeUInt32BE(bigEndian ? 0x377f0683 : 0x377f0682, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(pageSize, 8);
  header.writeUInt32BE(7, 12);
  salt1 = salt1 ?? 0x11223344;
  salt2 = salt2 ?? 0x55667788;
  header.writeUInt32BE(salt1, 16);
  header.writeUInt32BE(salt2, 20);
  let [s0, s1] = walChecksum(header, 0, 24, 0, 0, bigEndian);
  if (breakHeaderChecksum) {
    header.writeUInt32BE((s0 + 1) >>> 0, 24);
    header.writeUInt32BE(s1, 28);
    return header;
  }
  header.writeUInt32BE(s0, 24);
  header.writeUInt32BE(s1, 28);

  const parts = [header];
  for (const frame of frames) {
    const frameHeader = Buffer.alloc(24);
    frameHeader.writeUInt32BE(frame.page, 0);
    frameHeader.writeUInt32BE(frame.dbSize ?? 0, 4);
    frameHeader.writeUInt32BE(salt1, 8);
    frameHeader.writeUInt32BE(salt2, 12);
    [s0, s1] = walChecksum(frameHeader, 0, 8, s0, s1, bigEndian);
    [s0, s1] = walChecksum(frame.data, 0, frame.data.length, s0, s1, bigEndian);
    frameHeader.writeUInt32BE(frame.corruptChecksum ? (s0 + 1) >>> 0 : s0, 16);
    frameHeader.writeUInt32BE(frame.corruptChecksum ? s1 : s1, 20);
    parts.push(frameHeader, frame.data);
  }
  return Buffer.concat(parts);
}

function copyFixture(tempDir, dbName = 'ItemDB.db') {
  const dbPath = path.join(tempDir, dbName);
  fs.copyFileSync(path.join(FIXTURE_DIR, 'sample.db'), dbPath);
  fs.copyFileSync(path.join(FIXTURE_DIR, 'sample.db-wal'), `${dbPath}-wal`);
  return dbPath;
}

async function main() {
  const initSqlJs = require('sql.js');
  const {
    readSqliteDatabaseImage,
    removeSqliteSidecarFiles,
    restoreSqliteBackup,
    sqliteStateSha256,
  } = require('../out/utils/sqlite-wal');
  const { DatabaseBrowserSession } = require('../out/utils/database-browser');
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'expected.json'), 'utf8'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boo-wal-'));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boo-wal-session-'));

  try {
    const SQL = await initSqlJs();

    // 1. 真实 SQLite 生成的 WAL 夹具：合并后必须能看到 WAL 中已提交的全部行。
    const dbPath = copyFixture(tempDir);
    const image = readSqliteDatabaseImage(dbPath);
    assert.equal(image.walMerged, true, 'fixture WAL must be merged');
    assert.equal(image.walPageCount > 1, true, 'merged image must cover committed pages');
    const database = new SQL.Database(image.data);
    const rows = database.exec('SELECT IDX, NAME, Stock FROM StdItems ORDER BY IDX')[0].values;
    database.close();
    assert.deepEqual(
      rows.map(row => ({ IDX: row[0], NAME: row[1], Stock: row[2] })),
      expected.rows,
      'merged image must expose rows that only exist in the WAL'
    );

    // 原始主库单独打开时缺少 WAL 数据（回归基线）。
    const rawDatabase = new SQL.Database(fs.readFileSync(dbPath));
    const rawTables = rawDatabase.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values || [];
    rawDatabase.close();
    assert.ok(
      rawTables.every(table => table[0] !== 'StdItems'),
      'baseline sanity: raw main db must not contain the committed table'
    );

    // 2. 没有 WAL 时按主库原样返回。
    const noWalPath = path.join(tempDir, 'plain.db');
    fs.writeFileSync(noWalPath, Buffer.from(image.data));
    const noWal = readSqliteDatabaseImage(noWalPath);
    assert.equal(noWal.walMerged, false);
    assert.deepEqual(Buffer.from(noWal.data).subarray(0, 100), Buffer.from(image.data).subarray(0, 100));

    // 3. 损坏的 WAL 头（校验和不匹配）不合并。
    const base = Buffer.from(image.data);
    const pageSize = base.readUInt16BE(16);
    assert.equal(pageSize, 4096, 'fixture db must use the default page size');
    const basePage1 = base.subarray(0, pageSize);
    const marker = Buffer.from('BOO-WAL-MARKER-1');
    const markedPage1 = Buffer.from(basePage1);
    marker.copy(markedPage1, 200);
    const brokenHeaderWal = buildWal({
      pageSize,
      breakHeaderChecksum: true,
      frames: [{ page: 1, dbSize: 1, data: markedPage1 }],
    });
    const brokenHeaderPath = path.join(tempDir, 'broken-header.db');
    fs.writeFileSync(brokenHeaderPath, base);
    fs.writeFileSync(`${brokenHeaderPath}-wal`, brokenHeaderWal);
    const brokenHeaderImage = readSqliteDatabaseImage(brokenHeaderPath);
    assert.equal(brokenHeaderImage.walMerged, false, 'WAL header checksum mismatch must disable merge');

    // 4. 帧校验和不匹配：从坏帧起全部作废，坏帧之前的有效帧仍生效。
    const goodFrame = { page: 1, dbSize: 0, data: markedPage1 };
    const marker2 = Buffer.from('BOO-WAL-MARKER-2');
    const markedPage2 = Buffer.from(base.subarray(pageSize, pageSize * 2));
    marker2.copy(markedPage2, 300);
    const goodFrame2 = { page: 2, dbSize: 0, data: markedPage2 };
    const corruptChainWal = buildWal({
      pageSize,
      frames: [{ ...goodFrame, dbSize: 2 }, { ...goodFrame2, corruptChecksum: true, dbSize: 2 }],
    });
    const corruptChainPath = path.join(tempDir, 'corrupt-chain.db');
    fs.writeFileSync(corruptChainPath, base);
    fs.writeFileSync(`${corruptChainPath}-wal`, corruptChainWal);
    const corruptChainImage = readSqliteDatabaseImage(corruptChainPath);
    assert.equal(corruptChainImage.walMerged, true, 'frames before the corrupted frame stay valid');
    assert.equal(Buffer.from(corruptChainImage.data.subarray(pageSize + 300, pageSize + 316)).equals(marker2), false,
      'frames after a checksum mismatch must be discarded');
    assert.ok(Buffer.from(corruptChainImage.data.subarray(200, 216)).equals(marker),
      'frames before the corrupted frame must be applied');

    // 5. 未提交的帧（dbSizeAfterCommit = 0 且其后没有提交帧）必须被忽略。
    const uncommittedWal = buildWal({
      pageSize,
      frames: [
        { page: 1, dbSize: 2, data: markedPage1 },
        { page: 2, dbSize: 0, data: markedPage2 },
      ],
    });
    const uncommittedPath = path.join(tempDir, 'uncommitted.db');
    fs.writeFileSync(uncommittedPath, base);
    fs.writeFileSync(`${uncommittedPath}-wal`, uncommittedWal);
    const uncommittedImage = readSqliteDatabaseImage(uncommittedPath);
    assert.equal(uncommittedImage.walMerged, true);
    assert.equal(uncommittedImage.walPageCount, 2, 'only the committed transaction defines db size');
    assert.equal(Buffer.from(uncommittedImage.data.subarray(pageSize + 300, pageSize + 316)).equals(marker2), false,
      'uncommitted trailing frames must not leak into the image');
    assert.ok(Buffer.from(uncommittedImage.data.subarray(200, 216)).equals(marker),
      'committed frames must be applied');

    // 6. 帧盐值与 WAL 头不匹配的帧作废。
    const saltMismatchWal = buildWal({
      pageSize,
      salt1: 0x11223344,
      salt2: 0x55667788,
      frames: [
        { page: 1, dbSize: 2, data: markedPage1 },
        { page: 2, dbSize: 2, data: markedPage2, corruptChecksum: false },
      ],
    });
    // 手工把第二帧的盐值改掉并同步破坏校验和（模拟 checkpoint 后的旧帧残留）。
    const secondFrameOffset = 32 + 24 + pageSize;
    saltMismatchWal.writeUInt32BE(0xdeadbeef, secondFrameOffset + 8);
    const staleFramePath = path.join(tempDir, 'stale-frame.db');
    fs.writeFileSync(staleFramePath, base);
    fs.writeFileSync(`${staleFramePath}-wal`, saltMismatchWal);
    const staleFrameImage = readSqliteDatabaseImage(staleFramePath);
    assert.equal(staleFrameImage.walMerged, true);
    assert.equal(Buffer.from(staleFrameImage.data.subarray(pageSize + 300, pageSize + 316)).equals(marker2), false,
      'frames with mismatched salt must be discarded');

    // 7. 提交帧声明的库大小收缩必须生效（VACUUM 场景）。
    const shrinkWal = buildWal({
      pageSize,
      frames: [{ page: 1, dbSize: 1, data: markedPage1 }],
    });
    const shrinkPath = path.join(tempDir, 'shrink.db');
    fs.writeFileSync(shrinkPath, base);
    fs.writeFileSync(`${shrinkPath}-wal`, shrinkWal);
    const shrinkImage = readSqliteDatabaseImage(shrinkPath);
    assert.equal(shrinkImage.walMerged, true);
    assert.equal(shrinkImage.data.length, pageSize, 'commit frame db size must truncate the image');
    assert.ok(Buffer.from(shrinkImage.data.subarray(200, 216)).equals(marker));

    // 8. WAL 页大小与主库不一致时拒绝合并。
    const wrongPageSizeWal = buildWal({
      pageSize: 8192,
      frames: [{ page: 1, dbSize: 1, data: Buffer.alloc(8192) }],
    });
    const wrongPageSizePath = path.join(tempDir, 'wrong-page-size.db');
    fs.writeFileSync(wrongPageSizePath, base);
    fs.writeFileSync(`${wrongPageSizePath}-wal`, wrongPageSizeWal);
    const wrongPageSizeImage = readSqliteDatabaseImage(wrongPageSizePath);
    assert.equal(wrongPageSizeImage.walMerged, false, 'page size mismatch must disable merge');

    // 9. 只有未提交帧（无提交帧）不合并。
    const noCommitWal = buildWal({
      pageSize,
      frames: [{ page: 1, dbSize: 0, data: markedPage1 }],
    });
    const noCommitPath = path.join(tempDir, 'no-commit.db');
    fs.writeFileSync(noCommitPath, base);
    fs.writeFileSync(`${noCommitPath}-wal`, noCommitWal);
    assert.equal(readSqliteDatabaseImage(noCommitPath).walMerged, false, 'WAL without commit frames has nothing to merge');

    // 10. 状态指纹覆盖主库与 WAL：WAL 字节变化、出现或消失都必须改变指纹。
    const walOriginal = fs.readFileSync(`${noCommitPath}-wal`);
    const withWalFingerprint = sqliteStateSha256(noCommitPath);
    fs.appendFileSync(`${noCommitPath}-wal`, Buffer.from('extra'));
    assert.notEqual(sqliteStateSha256(noCommitPath), withWalFingerprint, 'WAL changes must change the state fingerprint');
    fs.writeFileSync(`${noCommitPath}-wal`, walOriginal);
    assert.equal(sqliteStateSha256(noCommitPath), withWalFingerprint, 'restoring WAL bytes restores the fingerprint');
    removeSqliteSidecarFiles(noCommitPath);
    assert.equal(fs.existsSync(`${noCommitPath}-wal`), false, 'sidecar removal must delete the WAL');
    const noWalFingerprint = sqliteStateSha256(noCommitPath);
    assert.notEqual(noWalFingerprint, withWalFingerprint, 'WAL presence must affect the fingerprint');
    fs.writeFileSync(`${noCommitPath}-wal`, walOriginal);
    assert.equal(sqliteStateSha256(noCommitPath), withWalFingerprint, 'recreated WAL restores the fingerprint again');
    removeSqliteSidecarFiles(noCommitPath);
    assert.equal(sqliteStateSha256(noCommitPath), noWalFingerprint, 'removing the WAL restores the no-WAL fingerprint');

    // 11. 备份/恢复往返：恢复时还原 WAL，备份没有 WAL 时清掉残留 WAL。
    const restorePath = copyFixture(tempDir, 'Restore.db');
    const backupPath = path.join(tempDir, 'boo-backups', 'Restore.db.bak');
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(restorePath, backupPath);
    fs.copyFileSync(`${restorePath}-wal`, `${backupPath}-wal`);
    removeSqliteSidecarFiles(restorePath);
    assert.equal(fs.existsSync(`${restorePath}-wal`), false);
    restoreSqliteBackup(backupPath, restorePath);
    assert.equal(fs.existsSync(`${restorePath}-wal`), true, 'restore must bring back the backed-up WAL');
    assert.equal(readSqliteDatabaseImage(restorePath).walMerged, true, 'restored state must still merge its WAL');

    const walLessPath = path.join(tempDir, 'WalLess.db');
    fs.writeFileSync(walLessPath, base);
    const walLessBackup = `${walLessPath}.bak`;
    fs.copyFileSync(walLessPath, walLessBackup);
    fs.writeFileSync(`${walLessPath}-wal`, Buffer.from('stray'));
    restoreSqliteBackup(walLessBackup, walLessPath);
    assert.equal(fs.existsSync(`${walLessPath}-wal`), false, 'restore without a WAL backup must drop stray WAL files');

    // 12. 会话集成：目录浏览必须读到 WAL 中已提交的行；保存后侧车清理、
    //     撤回恢复 WAL；外部改动 WAL 后拒绝保存。
    const sessionDbPath = copyFixture(sessionDir, 'ItemDB.db');
    const session = new DatabaseBrowserSession(sessionDir);
    let catalog;
    try {
      catalog = await session.initialize();
      const itemsTable = catalog.tables.find(table => table.name === 'StdItems');
      assert.ok(itemsTable, 'merged WAL must expose StdItems to the session');
      assert.equal(itemsTable.rowCount, expected.rows.length, 'row count must include WAL-committed rows');

      const page = await session.loadPage({
        tableId: itemsTable.id,
        offset: 0,
        limit: 50,
        query: '',
        sortColumn: 'IDX',
        sortDirection: 'asc',
      });
      assert.deepEqual(page.rows.map(row => row.NAME), expected.rows.map(row => row.NAME),
        'session must read rows that only exist in the WAL');

      const targetRow = page.rows.find(row => row.NAME === '铁剑');
      const update = await session.updateRows(itemsTable.id, [
        { rowId: targetRow.__booRowId, values: { Stock: 1234 } },
      ]);
      assert.equal(update.operation, 'update');
      assert.equal(fs.existsSync(`${sessionDbPath}-wal`), false,
        'saving must remove the stale WAL sidecar so SQLite cannot replay old frames over the new image');
      const savedDatabase = new SQL.Database(fs.readFileSync(sessionDbPath));
      const savedRows = savedDatabase.exec('SELECT IDX, NAME, Stock FROM StdItems ORDER BY IDX')[0].values;
      savedDatabase.close();
      assert.equal(savedRows.find(row => row[1] === '铁剑')[2], 1234, 'mutation must persist');

      const undo = await session.undoLastMutation();
      assert.equal(undo.revertedOperation, 'update');
      assert.equal(fs.existsSync(`${sessionDbPath}-wal`), true,
        'undo must restore the WAL backup together with the main db');
      const undoneImage = readSqliteDatabaseImage(sessionDbPath);
      assert.equal(undoneImage.walMerged, true, 'restored WAL must merge again');
      const undoneDatabase = new SQL.Database(undoneImage.data);
      const undoneRows = undoneDatabase.exec('SELECT Stock FROM StdItems WHERE NAME = \'铁剑\'')[0].values;
      undoneDatabase.close();
      assert.equal(undoneRows[0][0], 25, 'undo must restore the original value');

      // 外部改动 WAL 后必须拒绝保存。
      await session.loadPage({
        tableId: itemsTable.id,
        offset: 0,
        limit: 10,
        query: '',
        sortColumn: 'IDX',
        sortDirection: 'asc',
      });
      const beforeExternal = sqliteStateSha256(sessionDbPath);
      const currentWal = fs.readFileSync(`${sessionDbPath}-wal`);
      fs.appendFileSync(`${sessionDbPath}-wal`, crypto.randomBytes(16));
      assert.notEqual(sqliteStateSha256(sessionDbPath), beforeExternal);
      await assert.rejects(
        () => session.updateRows(itemsTable.id, [{ rowId: targetRow.__booRowId, values: { Stock: 4321 } }]),
        /已被外部修改/,
        'external WAL changes must cancel the save'
      );
      fs.writeFileSync(`${sessionDbPath}-wal`, currentWal);
    } finally {
      session.dispose();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  console.log('sqlite-wal-merge.test.js: PASS');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
