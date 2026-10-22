const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runChromiumDom } = require('./helpers/chromium-dom');
const { removeTemporaryDirectory } = require('./helpers/temp-cleanup');
const root = process.env.BOO_DATABASE_RUNTIME_ROOT
  ? path.resolve(process.env.BOO_DATABASE_RUNTIME_ROOT)
  : path.resolve(__dirname, '..');
const { DatabaseBrowserSession } = require(path.join(root, 'out/utils/database-browser'));
const MDBModule = require('mdb-reader');
const MDBReader = typeof MDBModule === 'function' ? MDBModule : MDBModule.default;

function findBrowsers() {
  return [...new Set([
    process.env.BOO_BROWSER_EXECUTABLE,
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(candidate => candidate && fs.existsSync(candidate)).map(candidate => path.resolve(candidate)))];
}

function createFixture(directory) {
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    [path.join(windows, 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe'), 'Microsoft.Jet.OLEDB.4.0'],
    [path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'Microsoft.ACE.OLEDB.16.0'],
    [path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'Microsoft.ACE.OLEDB.12.0'],
  ];
  const unavailable = [];
  for (const [index, [exe, provider]] of candidates.entries()) {
    if (!fs.existsSync(exe)) continue;
    const filePath = path.join(directory, `synthetic-${index}.mdb`);
    const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'helpers/access-fixture.ps1'), '-FilePath', filePath, '-Provider', provider],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Access browser fixture failed: ${result.stderr || result.stdout}`);
    const report = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    if (report.available) return { filePath, provider, architecture: report.architecture };
    unavailable.push(report.reason);
  }
  console.log(`database-access-browser.test.js: SKIP (no installed Jet/ACE provider; ${unavailable.join('; ')})`);
  return undefined;
}

function readTable(filePath, tableName) {
  return new MDBReader(fs.readFileSync(filePath)).getTable(tableName).getData();
}

const scenarioPrelude = String.raw`
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const check = (condition, message) => { if (!condition) throw Error(message); };
  async function until(predicate, label) {
    for (let attempt = 0; attempt < 900; attempt++) {
      if (predicate()) return;
      if (window.__hostError) throw Error(window.__hostError);
      await wait(20);
    }
    throw Error(label + '; status=' + document.getElementById('status').textContent);
  }
  const cell = (row, field) => document.querySelectorAll('.tabulator-row')[row]?.querySelector('[tabulator-field="' + field + '"]');
  function select(target) {
    check(target, 'required production grid cell is missing');
    for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, {bubbles:true,button:0}));
    target.focus();
  }
  async function ready() {
    await until(() => document.getElementById('table').dataset.ready === 'true' && !!cell(0, 'Name'), 'MDB grid did not render');
    await wait(60);
  }
  async function table(name) {
    await until(() => Array.isArray(window.tables) && window.tables.length > 0, 'catalog did not arrive');
    if (currentTable?.name !== name) {
      const tab = [...document.querySelectorAll('#tabs .tab')].find(button => button.title.endsWith(' / ' + name));
      check(tab, 'catalog has no table ' + name); tab.click();
    }
    await ready(); check(currentTable.name === name, 'wrong MDB table was rendered');
  }
  async function refreshed(before) {
    await until(() => window.__hostResponses.slice(before).some(message => ['databaseMutationResult','databaseUndoResult'].includes(message.type)), 'MDB mutation response did not arrive');
    await until(() => !mutationPending && document.getElementById('table').dataset.ready === 'true', 'MDB post-write page did not finish');
    await wait(80);
  }
  async function edit(row, field, value) {
    const target = cell(row, field); select(target);
    target.dispatchEvent(new MouseEvent('dblclick', {bubbles:true,button:0}));
    await until(() => !!target.querySelector('input'), 'MDB cell editor did not open');
    const input = target.querySelector('input'); input.value = String(value);
    const before = window.__hostResponses.length;
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}));
    await refreshed(before);
  }
  async function undo() {
    const before = window.__hostResponses.length;
    const header = document.querySelector('.tabulator-header'); header.focus();
    header.dispatchEvent(new KeyboardEvent('keydown', {key:'z',ctrlKey:true,bubbles:true,cancelable:true}));
    await refreshed(before);
  }
`;

const scenarios = {
  editAndUndo: String.raw`
    await table('StdItems');
    check(currentTable.kind === 'access' && currentTable.editable, 'MDB table is not editable');
    check(document.getElementById('manageFields').disabled, 'MDB schema editing must stay disabled');
    await edit(0, 'Price', 701);
    check(cell(0, 'Price').textContent.trim() === '701', 'single MDB edit was not repainted from saved data');
    check(window.__messages.some(message => message.type === 'updateDatabaseRow'), 'single edit bypassed production host message');
    const start = cell(0, 'Price'); select(start);
    const before = window.__hostResponses.length;
    const paste = new Event('paste', {bubbles:true,cancelable:true});
    Object.defineProperty(paste, 'clipboardData', {value:{getData:() => '801\r\n802'}});
    start.dispatchEvent(paste); await refreshed(before);
    const batch = window.__messages.find(message => message.type === 'updateDatabaseRows');
    check(batch && batch.updates.length === 2, 'MDB paste was not one two-row transaction');
    check(cell(0, 'Price').textContent.trim() === '801' && cell(1, 'Price').textContent.trim() === '802', 'saved batch values were not repainted');
    await undo();
    check(cell(0, 'Price').textContent.trim() === '701' && cell(1, 'Price').textContent.trim() === '20', 'Ctrl+Z did not restore batch state');
    await undo();
    check(cell(0, 'Price').textContent.trim() === '10', 'second Ctrl+Z did not restore original MDB value');
    document.body.dataset.checks = 'single,batch,undo,schema-protection';
  `,
  createAndProtectedFields: String.raw`
    await table('StdItems');
    document.getElementById('addDatabaseRow').click();
    check(!document.getElementById('mdbCreateModal').hidden, 'MDB create modal did not open');
    const field = name => document.querySelector('#mdbCreateFields .form-field[data-column="' + name + '"]');
    function value(name, text) {
      const target = field(name); check(target, 'MDB create field is missing: ' + name);
      target.querySelector('input').value = text;
      target.querySelector('input').dispatchEvent(new Event('input', {bubbles:true}));
      check(target.querySelector('select').value === 'value', 'typing did not select explicit value mode');
    }
    value('Id', '10'); value('Name', "浏览器 O'Brien"); value('Price', '77'); value('Enabled', 'true'); value('Note', '新增中文备注');
    field('Optional').querySelector('select').value = 'null';
    check(field('Created').querySelector('select').value === 'omit', 'unspecified field did not retain default mode');
    let before = window.__hostResponses.length;
    document.getElementById('mdbCreateAccept').click(); await refreshed(before);
    check(currentRows.some(row => row.Id === 10 && row.Name === "浏览器 O'Brien" && row.Optional === null), 'created MDB record did not survive close/reopen');
    const create = window.__messages.find(message => message.type === 'createDatabaseRow');
    check(create && create.values.Optional === null && !Object.hasOwn(create.values, 'Created'), 'create did not distinguish NULL from default omission');
    await undo(); check(currentRows.length === 3 && !currentRows.some(row => row.Id === 10), 'create undo did not remove the new record');
    await table('BinaryKey');
    const payload = cell(0, 'Payload'); check(payload, 'protected OLE cell did not render'); select(payload);
    payload.dispatchEvent(new MouseEvent('dblclick', {bubbles:true,button:0}));
    payload.dispatchEvent(new KeyboardEvent('keydown', {key:'F2',bubbles:true,cancelable:true}));
    await wait(80); check(!payload.querySelector('input'), 'protected OLE field opened an editor');
    const sent = window.__messages.length;
    const paste = new Event('paste', {bubbles:true,cancelable:true});
    Object.defineProperty(paste, 'clipboardData', {value:{getData:() => 'overwrite binary'}}); payload.dispatchEvent(paste);
    await wait(100);
    check(!window.__messages.slice(sent).some(message => /^updateDatabaseRow/.test(message.type)), 'binary paste dispatched a write');
    document.getElementById('addDatabaseRow').click();
    check(!field('Payload'), 'protected OLE field appeared in the MDB create form');
    document.querySelector('#mdbCreateModal [data-close-modal]').click();
    before = window.__hostResponses.length;
    document.getElementById('openDatabaseFile').click();
    await until(() => window.__hostResponses.slice(before).some(message => message.type === 'databaseCatalog'), 'file selection button did not load the selected fixture');
    await table('StdItems');
    check(window.__messages.some(message => message.type === 'selectDatabaseFile'), 'open database button did not request the host chooser');
    before = window.__hostResponses.length;
    document.getElementById('reloadDatabaseSource').click();
    await until(() => window.__hostResponses.slice(before).some(message => message.type === 'databaseCatalog'), 'reopen did not refresh the real MDB session');
    await table('StdItems');
    check(window.__messages.some(message => message.type === 'reloadDatabaseSource'), 'reopen button did not call the host');
    document.body.dataset.checks = 'create,null,default,create-undo,protected-ole,file-selection-message,reopen';
  `,
  precisionProtection: String.raw`
    await table('StdItems');
    // This scenario controls only the UI's declared type. The physical fixture
    // remains LONG; physical currency/numeric conversion is covered separately.
    const originalType = currentTable.columnTypes.Price;
    const changes = () => window.__messages.filter(message => /^updateDatabaseRow/.test(message.type)).length;
    function range(start, end) {
      select(start);
      for (const type of ['mousedown','mouseup','click']) end.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,shiftKey:true}));
    }
    const initialWrites = changes();
    for (const declared of ['CURRENCY','NUMERIC','BIGINT']) {
      currentTable.columnTypes.Price = declared;
      range(cell(0,'Price'),cell(1,'Price')); await wait(40);
      const target = cell(1,'Price');
      target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:400,clientY:300}));
      document.getElementById('contextIncrementCells').click();
      check(document.getElementById('incrementModal').hidden, declared + ' automatic increment modal opened');
      check(/精确数值/.test(document.getElementById('status').textContent), declared + ' did not explain precision protection');
      select(cell(0,'Price')); await wait(40);
      document.getElementById('fillHandle').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
      cell(1,'Price').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
      check(!fillState, declared + ' drag fill was not cancelled');
    }
    check(changes() === initialWrites, 'protected automatic arithmetic dispatched a write');
    // Recheck when a once-valid modal or drag expands into a protected field.
    currentTable.columnTypes.Price = originalType;
    range(cell(0,'Price'),cell(1,'Price')); openIncrementModal();
    check(!document.getElementById('incrementModal').hidden, 'ordinary LONG increment no longer opens');
    currentTable.columnTypes.Price = 'CURRENCY';
    document.getElementById('incrementAccept').click();
    check(document.getElementById('incrementModal').hidden && changes() === initialWrites, 'increment apply ignored a protected declared type');
    select(cell(0,'Id')); await wait(40);
    document.getElementById('fillHandle').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
    cell(1,'Price').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
    check(!fillState && changes() === initialWrites, 'drag expansion wrote through a protected field');
    // Literal paste and Ctrl+D copy still pass through the real saving backend.
    const start = cell(0,'Price'); select(start);
    let before = window.__hostResponses.length;
    const paste = new Event('paste',{bubbles:true,cancelable:true});
    Object.defineProperty(paste,'clipboardData',{value:{getData:() => '901'}});start.dispatchEvent(paste);
    await refreshed(before); check(cell(0,'Price').textContent.trim() === '901', 'precision protection blocked literal paste');
    currentTable.columnTypes.Price = 'CURRENCY';
    range(cell(0,'Price'),cell(1,'Price'));before = window.__hostResponses.length;
    cell(1,'Price').dispatchEvent(new KeyboardEvent('keydown',{key:'d',ctrlKey:true,bubbles:true,cancelable:true}));
    await refreshed(before);
    check(cell(1,'Price').textContent.trim() === '901', 'precision protection blocked literal Ctrl+D copy');
    await undo(); await undo();
    document.body.dataset.checks = 'currency-numeric-bigint-arithmetic-protection,apply-recheck,drag-expansion,literal-paste,ctrl-d-copy';
  `,
};

async function runScenario(browser, directory, seed, name, scenario) {
  const filePath = path.join(directory, 'synthetic.mdb');
  fs.copyFileSync(seed, filePath);
  const initial = fs.readFileSync(filePath);
  const initialRows = readTable(filePath, 'StdItems');
  const initialBinary = readTable(filePath, 'BinaryKey');
  let session = new DatabaseBrowserSession(filePath);
  await session.initialize();
  const requests = [], snapshots = [];
  async function handle(message) {
    requests.push(message);
    try {
      if (['ready', 'selectDatabaseFile', 'reloadDatabaseSource'].includes(message.type)) {
        if (message.type !== 'ready') {
          session.dispose(); session = new DatabaseBrowserSession(filePath);
        }
        return { type: 'databaseCatalog', ...await session.initialize() };
      }
      if (message.type === 'loadDatabasePage') {
        return { type: 'databasePage', requestId: message.requestId, ...await session.loadPage(message) };
      }
      let result;
      if (message.type === 'updateDatabaseRow') result = await session.updateRow(message.tableId, message.rowId, message.values);
      else if (message.type === 'updateDatabaseRows') result = await session.updateRows(message.tableId, message.updates);
      else if (message.type === 'createDatabaseRow') result = await session.createRow(message.tableId, message.values);
      else if (message.type === 'undoDatabaseMutation') {
        result = await session.undoLastMutation();
        snapshots.push({ type: message.type, rows: readTable(filePath, 'StdItems') });
        return { type: 'databaseUndoResult', requestId: message.requestId, result, catalog: await session.initialize() };
      } else return null;
      snapshots.push({ type: message.type, rows: readTable(filePath, 'StdItems') });
      const catalog = await session.initialize();
      return { type: 'databaseMutationResult', requestId: message.requestId, result,
        table: catalog.tables.find(table => table.id === message.tableId), totalCount: catalog.totalCount };
    } catch (error) {
      return { type: message.type === 'loadDatabasePage' ? 'databaseError' : 'databaseMutationError',
        requestId: message.requestId, error: error.message };
    }
  }
  const token = crypto.randomBytes(24).toString('hex');
  let renderedHtml = '';
  const assets = [
    'media/vendor/tabulator/tabulator_midnight.min.css',
    'media/table-editor-core.js',
    'media/vendor/tabulator/tabulator.min.js',
  ];
  let queued = Promise.resolve();
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && request.url === '/' + token + '/page') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(renderedHtml); return;
    }
    const assetIndex = assets.findIndex((_asset, index) => request.url === '/' + token + '/asset/' + index);
    if (request.method === 'GET' && assetIndex >= 0) {
      response.setHeader('Content-Type', assetIndex === 0 ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      response.end(fs.readFileSync(path.join(root, assets[assetIndex]))); return;
    }
    if (request.method !== 'POST' || request.url !== '/' + token) {
      response.writeHead(404); response.end('{}'); return;
    }
    let input = '';
    request.on('data', chunk => { input += chunk; if (input.length > 1000000) request.destroy(); });
    request.on('end', () => {
      queued = queued.then(async () => {
        const output = await handle(JSON.parse(input));
        response.end(JSON.stringify(output));
      }).catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = 'http://127.0.0.1:' + server.address().port + '/' + token;
    let html = fs.readFileSync(path.join(root, 'media/database-viewer.html'), 'utf8');
    const resources = {
      '{{TABULATOR_CSS_URI}}': 'media/vendor/tabulator/tabulator_midnight.min.css',
      '{{TABLE_EDITOR_CORE_URI}}': 'media/table-editor-core.js',
      '{{TABULATOR_JS_URI}}': 'media/vendor/tabulator/tabulator.min.js',
    };
    for (const [placeholder, relative] of Object.entries(resources)) html = html.replaceAll(placeholder, api + '/asset/' + assets.indexOf(relative));
    const bridge = `<script>
window.__messages = []; window.__hostResponses = [];
window.acquireVsCodeApi = function() { return { postMessage: function(message) {
  window.__messages.push(message);
  fetch(${JSON.stringify(api)}, {method:'POST',body:JSON.stringify(message)}).then(function(response) {
    if(!response.ok) throw Error('test host HTTP ' + response.status); return response.json();
  }).then(function(message) {
    if(!message) return; window.__hostResponses.push(message);
    if(/Error$/.test(message.type)) window.__hostError = message.error;
    window.dispatchEvent(new MessageEvent('message', {data:message}));
  }).catch(function(error) { window.__hostError = error.message; });
} }; };
window.addEventListener('error', function(event) { window.__hostError = String(event.error?.stack || event.message); });
</script>`;
    const coreTag = `<script src="${api}/asset/1"></script>`;
    assert.ok(html.includes(coreTag), 'production table editor resource tag changed');
    html = html.replace(coreTag, bridge + coreTag);
    html = html.replace('</body>', `<script>
(async function() { try {
${scenarioPrelude}
${scenario}
  if(window.__hostError) throw Error(window.__hostError);
  document.body.dataset.testStatus = 'pass';
} catch(error) { document.body.dataset.testError = String(error.stack || error); document.body.dataset.testStatus = 'fail'; } }());
</script></body>`);
    const harness = path.join(directory, name + '.html');
    renderedHtml = html;
    // Use the shared CDP harness's file entry point, then navigate to a same-
    // origin loopback test page. Modern Chromium blocks file-to-localhost fetch.
    fs.writeFileSync(harness, `<script>location.replace(${JSON.stringify(api + '/page')})</script>`, 'utf8');
    const dom = await runChromiumDom(browser, harness, path.join(directory, 'profile'));
    const body = dom.match(/<body\b([^>]*)>/i);
    assert.ok(body, 'real Chromium did not return a completed body');
    assert.match(body[1], /data-test-status="pass"/, body[1]);
    assert.deepEqual(readTable(filePath, 'StdItems'), initialRows, 'browser edit/undo must preserve every original MDB record');
    assert.deepEqual(readTable(filePath, 'BinaryKey'), initialBinary, 'browser edits must preserve protected OLE bytes');
    assert.deepEqual(fs.readFileSync(filePath), initial, 'undo must restore exact original MDB bytes');
    if (name === 'editAndUndo') {
      assert.equal(snapshots.find(snapshot => snapshot.type === 'updateDatabaseRow').rows[0].Price, 701);
      assert.deepEqual(snapshots.find(snapshot => snapshot.type === 'updateDatabaseRows').rows.slice(0, 2).map(row => row.Price), [801, 802]);
      assert.equal(snapshots.filter(snapshot => snapshot.type === 'undoDatabaseMutation').length, 2);
    } else if (name === 'createAndProtectedFields') {
      const created = snapshots.find(snapshot => snapshot.type === 'createDatabaseRow').rows.find(row => row.Id === 10);
      assert.equal(created.Name, "浏览器 O'Brien"); assert.equal(created.Optional, null); assert.equal(created.Enabled, true);
      assert.ok(requests.some(message => message.type === 'selectDatabaseFile'));
      assert.ok(requests.some(message => message.type === 'reloadDatabaseSource'));
    } else {
      assert.deepEqual(snapshots.filter(snapshot => snapshot.type === 'updateDatabaseRows').map(snapshot => snapshot.rows.slice(0, 2).map(row => row.Price)), [[901,20],[901,901]]);
      assert.equal(snapshots.filter(snapshot => snapshot.type === 'undoDatabaseMutation').length, 2);
    }
    console.log(`Access browser scenario ${name}: PASS (real MDB reopen + independent reader; ${snapshots.length} writes/undos)`);
  } finally {
    await queued;
    session.dispose();
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('database-access-browser.test.js: SKIP (real Jet/ACE integration requires Windows)'); return;
  }
  const browsers = findBrowsers();
  if (!browsers.length) {
    console.log('database-access-browser.test.js: SKIP (no installed Chromium browser)'); return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'boo-access-browser-'));
  try {
    const fixture = createFixture(temporary);
    if (!fixture) return;
    for (const [name, scenario] of Object.entries(scenarios)) {
      const directory = path.join(temporary, name); fs.mkdirSync(directory);
      await runScenario(browsers[0], directory, fixture.filePath, name, scenario);
    }
    console.log(`database-access-browser.test.js: PASS (production HTML/Tabulator, real-time CDP, ${fixture.provider}, ${fixture.architecture}-bit, browser=${browsers[0]})`);
  } finally { removeTemporaryDirectory(temporary); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
