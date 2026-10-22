const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runChromiumDom } = require('./helpers/chromium-dom');
const { removeTemporaryDirectory } = require('./helpers/temp-cleanup');
const root = process.env.BOO_DATABASE_RUNTIME_ROOT
  ? path.resolve(process.env.BOO_DATABASE_RUNTIME_ROOT)
  : path.resolve(__dirname, '..');

function findBrowser() {
  return [process.env.BOO_BROWSER_EXECUTABLE,
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
  ].find(candidate => candidate && fs.existsSync(candidate));
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('database-detail-fields-only-browser.test.js: SKIP (no installed Chromium browser)'); return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'boo-fields-only-detail-'));
  try {
    const mock = `<script>
window.__messages = [];
window.acquireVsCodeApi = function() { return {
  getState:function(){return {name:'cached external item',detailKind:'item',fieldsOnly:true,fields:{Name:'cached external item',Looks:9},topDesc:'stale workspace note',itemDesc:'stale workspace description',itemImageLabel:'stale workspace image'}},
  setState:function(value){window.__savedDetail = value},
  postMessage:function(value){window.__messages.push(value)}
}; };
</script>`;
    const scenario = `<script>
(function() { try {
  const content = document.getElementById('content');
  const check = (condition, label) => { if (!condition) throw Error(label); };
  function send(detail) { window.dispatchEvent(new MessageEvent('message', {data:{type:'showDatabaseDetail',...detail}})); }
  function protectedDetail(label) {
    check(!!content.querySelector('.prop-table'), label + ': database field table disappeared');
    check(!content.querySelector('textarea,input,button,img,.item-material,.monster-composite-viewport,.monster-editor'), label + ': workspace resources or writable controls appeared');
    check(!content.textContent.includes('MonItems') && !content.textContent.includes('MonIcons'), label + ': workspace file paths appeared');
  }
  protectedDetail('restored external state');
  check(content.textContent.includes('cached external item'), 'cached external fields were not restored');

  send({name:'same item',detailKind:'item',fields:{Name:'same item',Looks:9,Price:88},topDesc:'workspace top',itemDesc:'workspace note',itemImageLabel:'workspace item preview'});
  check(!!content.querySelector('#ta_topDesc') && !!content.querySelector('.item-material'), 'regular workspace item editing regressed');
  document.getElementById('ta_topDesc').value = 'normal item edit';
  saveDesc('topDesc');
  check(window.__messages.some(message => message.type === 'saveItemDesc' && message.text === 'normal item edit'), 'workspace item save no longer dispatches');
  send({name:'same item',detailKind:'item',fieldsOnly:true,preserveSelectionVisuals:true,fields:{Name:'external item',Looks:19,Price:99}});
  protectedDetail('external item');
  check(content.textContent.includes('物品属性') && content.textContent.includes('external item') && content.textContent.includes('99'), 'external item field type/value rendering failed');
  check(!_detail.itemImage && !_detail.itemImageLabel, 'external item inherited workspace visual state');

  send({name:'same monster',detailKind:'monster',fields:{Name:'same monster',HP:123},dropRateText:'1/1 workspace item',iconText:'7 1',dropRateFileName:'MonItems\\\\same monster.txt',iconFileName:'MonIcons\\\\same monster.txt'});
  check(!!document.getElementById('ta_dropRateText') && !!document.getElementById('ta_iconText'), 'regular workspace monster editors regressed');
  saveMonsterDetail('dropRateText');
  check(window.__messages.some(message => message.type === 'saveMonsterDetail'), 'workspace monster save no longer dispatches');
  send({name:'same monster',detailKind:'monster',fieldsOnly:true,fields:{Name:'external monster',HP:456},dropRateText:'wrong workspace drop',iconText:'7 1',monsterBody:{label:'wrong workspace body'},monsterIcons:[{}],topDesc:'wrong workspace note'});
  protectedDetail('external monster');
  check(content.textContent.includes('怪物属性') && content.textContent.includes('生命值') && content.textContent.includes('456'), 'external monster typed fields disappeared');

  const before = window.__messages.length, state = JSON.stringify(_detail);
  for (const key of ['dropRateText','iconText','topDesc','itemDesc']) {
    const textarea = document.createElement('textarea'); textarea.id = 'ta_' + key; textarea.value = 'stale editor'; document.body.appendChild(textarea);
  }
  saveMonsterDetail('dropRateText'); saveMonsterDetail('iconText'); saveDesc('topDesc'); saveDesc('itemDesc');
  check(window.__messages.length === before, 'fields-only direct save emitted a workspace write message');
  check(JSON.stringify(_detail) === state, 'fields-only direct description save mutated stored detail');
  document.querySelectorAll('body > textarea').forEach(node => node.remove());

  send({name:'external skill',detailKind:'skill',fieldsOnly:true,fields:{MagName:'external heal',Spell:7},itemDesc:'wrong note'});
  protectedDetail('external skill');
  check(content.textContent.includes('技能属性') && content.textContent.includes('魔法消耗') && content.textContent.includes('external heal'), 'external skill fields used the wrong detail type');
  send({name:'external custom table',detailKind:'other',fieldsOnly:true,fields:{Custom:'custom scalar'},columnLabels:{Custom:'自定义字段'}});
  protectedDetail('external other');
  check(content.textContent.includes('数据属性') && content.textContent.includes('自定义字段') && content.textContent.includes('custom scalar'), 'external custom field labels disappeared');
  document.body.dataset.testStatus = 'pass';
} catch(error) { document.body.dataset.testError = String(error.stack || error); document.body.dataset.testStatus = 'fail'; } }());
</script>`;
    const source = fs.readFileSync(path.join(root, 'media/sidebar-detail.html'), 'utf8');
    const html = source.replace('<script>', mock + '<script>').replace('</body>', scenario + '</body>');
    const harness = path.join(temporary, 'fields-only.html');
    fs.writeFileSync(harness, html, 'utf8');
    const dom = await runChromiumDom(browser, harness, path.join(temporary, 'profile'));
    const body = dom.match(/<body\b([^>]*)>/i);
    assert.ok(body, 'real Chromium did not return a completed detail DOM');
    assert.match(body[1], /data-test-status="pass"/, body[1]);
    console.log('database-detail-fields-only-browser.test.js: PASS (production sidebar, typed fields, no workspace editors or write messages; real-time CDP)');
  } finally { removeTemporaryDirectory(temporary); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
