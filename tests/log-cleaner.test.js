const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const { cleanAllLogs } = require('../out/utils/log-cleaner');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boo-log-clean-'));
  try {
    // 反向对照：工作区内的真实日志目录必须照常清理
    const realLog = path.join(root, 'real', 'DBServer', 'Log');
    fs.mkdirSync(realLog, { recursive: true });
    fs.writeFileSync(path.join(realLog, 'a.txt'), 'x');
    fs.writeFileSync(path.join(realLog, 'keep.log'), 'x');

    // ST-08：固定清理目录若是 junction/符号链接且指向工作区之外，必须整目录跳过
    const outsideLog = path.join(root, 'outside', 'Log');
    fs.mkdirSync(outsideLog, { recursive: true });
    fs.writeFileSync(path.join(outsideLog, 'external.txt'), 'x');
    const wsRoot = path.join(root, 'ws');
    fs.mkdirSync(path.join(wsRoot, 'DBServer'), { recursive: true });
    try {
      fs.symlinkSync(outsideLog, path.join(wsRoot, 'DBServer', 'Log'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      console.log('log-cleaner.test.js: SKIP (symlink/junction creation not permitted on this host)');
      return;
    }

    const [filesOk, dirsOk, fail, skip] = await cleanAllLogs(wsRoot);
    assert.ok(
      fs.existsSync(path.join(outsideLog, 'external.txt')),
      'logs outside the workspace must survive a linked cleanup root'
    );
    assert.equal(filesOk, 0, 'no external file may be deleted through the link');
    assert.equal(dirsOk, 0);
    assert.equal(fail, 0);
    assert.ok(skip >= 1, 'the out-of-root linked directory must be reported as skipped');

    const [filesOkReal, failReal] = await cleanAllLogs(path.join(root, 'real'));
    assert.equal(filesOkReal, 1, 'a real in-root log directory is still cleaned');
    assert.equal(failReal, 0);
    assert.ok(!fs.existsSync(path.join(realLog, 'a.txt')));
    assert.ok(fs.existsSync(path.join(realLog, 'keep.log')), 'non-matching extensions must be kept');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('log-cleaner.test.js: PASS');
}

main().catch(error => { console.error(error); process.exit(1); });
