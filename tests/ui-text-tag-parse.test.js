// VISUAL-02/03/04 回归：文字标签解析必须支持负坐标、含冒号内容、同行多标签；
// 属性键大小写不敏感；fcolor=0 是合法黑色不得被默认值覆盖；写读坐标补偿必须对称。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function main() {
  const editor = fs.readFileSync(
    path.join(process.env.BOO_PAK_RUNTIME_ROOT || path.join(__dirname, '..'), 'media', 'editor.html'),
    'utf8'
  );
  const pad3 = editor.match(/function pad3\(n\)\{[^\r\n]+\}/)?.[0];
  assert.ok(pad3, 'pad3 must exist in editor.html');
  const helpersStart = editor.indexOf('function parseTextTagProps');
  assert.ok(helpersStart >= 0, 'parseTextTagProps must exist in editor.html');
  const helpersEnd = editor.indexOf('var TEXT_TAG_RE', helpersStart);
  assert.ok(helpersEnd > helpersStart, 'TEXT_TAG_RE must follow the helpers');
  const tagRe = editor.slice(helpersEnd, editor.indexOf('\n', helpersEnd));
  const source = `${pad3}\n${editor.slice(helpersStart, helpersEnd)}\n${tagRe}\n${mountDriver()}`;

  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  const evalInContext = (expr) => vm.runInContext(expr, context);

  // 1) 负坐标 + 属性键大小写不敏感
  const negative = evalInContext(
    `parseOne('<&text:欢迎:-4:20{FCOLOR=250}/@main>')`
  );
  assert.equal(negative.content, '欢迎');
  assert.equal(negative.x, -4);
  assert.equal(negative.y, 20);
  assert.equal(negative.props.color, 250, 'FCOLOR must be matched case-insensitively');
  assert.equal(negative.script, 'main');

  // 2) 内容含冒号：非贪婪回溯必须把最后一个数字对交给坐标
  const colon = evalInContext(
    `parseOne('<&text:剩余时间:30:12:40:50{fcolor=0}>')`
  );
  assert.equal(colon.content, '剩余时间:30:12');
  assert.equal(colon.x, 40);
  assert.equal(colon.y, 50);
  assert.equal(colon.props.color, 0, 'fcolor=0 is a legal black and must not fall back to 255');

  // 3) 既有 npc-dialog 夹具仍可解析（内容含 | ^ # 与数字）
  const npc = evalInContext(
    `parseOne('<&text:默认内容|这些是备注^换一行^250#这行字是绿色:20:30{FCOLOR=250}>')`
  );
  assert.equal(npc.content, '默认内容|这些是备注^换一行^250#这行字是绿色');
  assert.equal(npc.x, 20);
  assert.equal(npc.y, 30);

  // 4) 同一行多个文字标签全部解析（VISUAL-04）
  const both = evalInContext(
    `parseAll('<&text:左:10:10{fcolor=251}><&text:右:-30:-40{fcolor=0}>')`
  );
  assert.equal(both.length, 2, 'both text tags on one line must be parsed');
  assert.equal(both[0].content, '左');
  assert.equal(both[1].x, -30);
  assert.equal(both[1].props.color, 0);

  // 5) intOr：仅 undefined/NaN 回退，合法 0 原样保留（VISUAL-02）
  assert.equal(evalInContext('intOr(0, 255)'), 0);
  assert.equal(evalInContext('intOr(undefined, 255)'), 255);
  assert.equal(evalInContext('intOr("abc", 128)'), 128);
  assert.equal(evalInContext('intOr("-006", 255)'), -6);

  // 6) 写读对称：文字/倒计时写侧 +4 补偿，解析侧减 4，负坐标往返稳定（VISUAL-03/VISUAL-04）
  for (const x of [-120, -6, -4, 0, 7, 300]) {
    const encoded = evalInContext(`pad3(${x} + 4)`);
    const parsed = evalInContext(`parseInt(${JSON.stringify(encoded)}, 10) - 4`);
    assert.equal(parsed, x, `round-trip x=${x} via pad3 "${encoded}"`);
  }

  console.log('ui-text-tag-parse.test.js: PASS');
}

// 与 editor.html 解析循环同口径的最小驱动
function mountDriver() {
  return `
  function parseOne(line) {
    TEXT_TAG_RE.lastIndex = 0;
    var m = TEXT_TAG_RE.exec(line);
    if (!m) return null;
    return { content: m[1], x: parseInt(m[2], 10), y: parseInt(m[3], 10), props: parseTextTagProps(m[4]), script: m[5] || '' };
  }
  function parseAll(line) {
    TEXT_TAG_RE.lastIndex = 0;
    var out = [], m;
    while ((m = TEXT_TAG_RE.exec(line)) !== null) {
      out.push({ content: m[1], x: parseInt(m[2], 10), y: parseInt(m[3], 10), props: parseTextTagProps(m[4]) });
    }
    return out;
  }`;
}

main();
