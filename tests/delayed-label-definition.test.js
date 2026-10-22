const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

// Exercise the actual registrations made by activateAssistant, not a copied
// regular expression or extracted provider body. No extension host is started.
const runtime = path.resolve(process.env.BOO_SCRIPT_RUNTIME_ROOT || path.join(__dirname, '..'));
const disposable = () => ({ dispose() {} });
let cases = 0;
let documentVersion = 0;

class TestUri {
  constructor(value) { this.value = value; this.scheme = value.split(':')[0]; this.fsPath = this.scheme === 'file' ? fileURLToPath(value) : ''; }
  static file(value) { return new TestUri(pathToFileURL(path.resolve(value)).href); }
  static parse(value) { return new TestUri(value); }
  toString() { return this.value; }
}
class TestPosition { constructor(line, character) { this.line = line; this.character = character; } }
class TestRange {
  constructor(...args) {
    this.start = typeof args[0] === 'number' ? new TestPosition(args[0], args[1]) : args[0];
    this.end = typeof args[0] === 'number' ? new TestPosition(args[2], args[3]) : args[1];
  }
}
class TestLocation { constructor(uri, position) { this.uri = uri; this.range = position.start ? position : new TestRange(position, position); } }
class TestCodeLens { constructor(range, command) { this.range = range; this.command = command; } }
class TestEventEmitter { constructor() { this.event = disposable; } fire() {} dispose() {} }

function makeDocument(text, fileName = path.join(runtime, 'test-fixtures', 'Mir200', 'Envir', 'QuestDiary', '延迟跳转.txt')) {
  let content = text;
  const document = {
    fileName, uri: TestUri.file(fileName), languageId: 'gomscript', version: ++documentVersion, isDirty: true,
    get lineCount() { return content.split(/\r\n|\r|\n/).length; },
    getText(range) {
      if (!range) return content;
      return content.slice(document.offsetAt(range.start), document.offsetAt(range.end));
    },
    lineAt(index) {
      const value = content.split(/\r\n|\r|\n/)[typeof index === 'number' ? index : index.line];
      return { text: value, range: new TestRange(typeof index === 'number' ? index : index.line, 0, typeof index === 'number' ? index : index.line, value.length) };
    },
    positionAt(offset) {
      const prefix = content.slice(0, Math.max(0, Math.min(offset, content.length)));
      const lines = prefix.split(/\r\n|\r|\n/);
      return new TestPosition(lines.length - 1, lines[lines.length - 1].length);
    },
    offsetAt(position) {
      const lines = content.split(/\r\n|\r|\n/);
      const starts = [...content.matchAll(/\r\n|\r|\n/g)];
      return (position.line ? starts[position.line - 1].index + starts[position.line - 1][0].length : 0) + Math.min(position.character, lines[position.line].length);
    },
    getWordRangeAtPosition(position) {
      const line = this.lineAt(position.line).text;
      for (const match of line.matchAll(/[\p{L}\p{N}_]+/gu)) {
        if (position.character >= match.index && position.character < match.index + match[0].length) return new TestRange(position.line, match.index, position.line, match.index + match[0].length);
      }
      return undefined;
    },
    replace(value) { content = value; this.version = ++documentVersion; },
  };
  return document;
}

function activateWithStub() {
  const providers = {}, events = {}, commands = new Map(), diagnostics = new Map(), sideEffects = [];
  let engine = 'GOM';
  const workspace = {
    workspaceFolders: [], textDocuments: [],
    getConfiguration(_name, scope) {
      return { get(key, fallback) { if (key === 'engine') return scope?.engine || engine; if (key === 'autoDetectEngine') return false; return fallback; } };
    },
    getWorkspaceFolder() { return undefined; },
    async findFiles() { return []; },
    async openTextDocument() { sideEffects.push('openTextDocument'); throw new Error('same-file jump must not read disk'); },
    fs: { async readFile() { sideEffects.push('readFile'); throw new Error('unexpected file read'); }, async writeFile() { throw new Error('unexpected file write'); } },
  };
  for (const name of ['onDidChangeTextDocument', 'onDidSaveTextDocument', 'onDidChangeWorkspaceFolders', 'onDidChangeConfiguration', 'onDidOpenTextDocument', 'onDidCloseTextDocument', 'onDidCreateFiles', 'onDidDeleteFiles', 'onDidRenameFiles']) {
    workspace[name] = callback => { (events[name] ||= []).push(callback); return disposable(); };
  }
  const languages = {
    createDiagnosticCollection() {
      return { set(uri, values) { diagnostics.set(uri.toString(), values); }, delete(uri) { diagnostics.delete(uri.toString()); }, clear() { diagnostics.clear(); }, forEach() {}, dispose() {} };
    },
  };
  for (const kind of ['CompletionItem', 'Hover', 'Definition', 'DocumentLink', 'Reference', 'DocumentSymbol', 'FoldingRange', 'CodeLens', 'CodeActions', 'SignatureHelp', 'DocumentSemanticTokens']) {
    languages[`register${kind}Provider`] = (_selector, provider) => { providers[kind] = provider; return disposable(); };
  }
  const window = {
    activeTextEditor: undefined, visibleTextEditors: [],
    createOutputChannel() { return { appendLine() {}, dispose() {} }; },
    createTextEditorDecorationType: disposable,
    onDidChangeActiveTextEditor: disposable, onDidChangeVisibleTextEditors: disposable,
    registerTreeDataProvider: disposable,
    createStatusBarItem() { return { show() {}, dispose() {} }; },
    showWarningMessage() { throw new Error('definition lookup must not show UI'); },
    showErrorMessage() { throw new Error('definition lookup must not show UI'); },
  };
  const api = {
    Uri: TestUri, Position: TestPosition, Range: TestRange, Location: TestLocation, CodeLens: TestCodeLens,
    EventEmitter: TestEventEmitter, TreeItem: class {}, ThemeIcon: class {}, SemanticTokensLegend: class {},
    Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Right: 2 }, DecorationRangeBehavior: { ClosedOpen: 0 },
    CodeActionKind: { QuickFix: 'quickfix' },
    workspace, window, languages,
    commands: { registerCommand(name, callback) { commands.set(name, callback); return disposable(); }, registerTextEditorCommand(name, callback) { commands.set(name, callback); return disposable(); }, async executeCommand() {} },
  };
  const state = { get(_key, fallback) { return fallback; }, async update() {} };
  const context = { subscriptions: [], extensionPath: runtime, extensionUri: TestUri.file(runtime), globalState: state, workspaceState: state };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) { return request === 'vscode' ? api : originalLoad.call(this, request, parent, isMain); };
  try { require(path.join(runtime, 'out', 'assistant')).activateAssistant(context); }
  finally { Module._load = originalLoad; }
  return { providers, events, commands, diagnostics, sideEffects, workspace, setEngine(value) { engine = value; }, dispose() { for (const subscription of context.subscriptions) subscription?.dispose(); } };
}

async function main() {
  const host = activateWithStub();
  const definition = host.providers.Definition;
  assert.equal(typeof definition?.provideDefinition, 'function', 'activateAssistant must register the production DefinitionProvider');
  async function check(name, body) { await body(); cases++; console.log(`delayed-label-definition: PASS - ${name}`); }
  async function jump(document, line, character) { return definition.provideDefinition(document, new TestPosition(line, character), { isCancellationRequested: false }); }
  const target = '延迟_回调-结束';
  try {
    await check('DELAYGOTO and DELAYCALL navigate from @ and every Chinese/static label character', async () => {
      for (const engine of ['GOM', 'GEE']) {
        host.setEngine(engine);
        for (const raw of [`DELAYGOTO 1000 @${target}`, `delaycall 1000 @${target}`, `#ACT(DELAYGOTO 1000 @${target})`, `#ELSEACT DelayCall 1000 @${target}`]) {
          const document = makeDocument(`[@main]\r\n#ACT\r\n${raw}\r\n\uFEFF  [@${target}]\r\n#ACT\r\n`);
          const start = raw.indexOf('@');
          for (const character of [start, start + 1, start + target.length]) {
            const location = await jump(document, 2, character);
            assert.ok(location, `${engine}: ${raw} at ${character} must navigate`);
            assert.equal(location.uri.toString(), document.uri.toString());
            assert.deepEqual(location.range.start, new TestPosition(3, 3));
          }
          assert.equal(await jump(document, 2, raw.toUpperCase().indexOf('DELAY')), null, 'command token does not become a label link');
          assert.equal(await jump(document, 2, raw.indexOf('1000')), null, 'delay duration does not become a label link');
          assert.equal(await jump(document, 2, start - 1), null, 'space before @ is not a target');
          assert.equal(await jump(document, 2, start + target.length + 1), null, 'target span end is half-open');
        }
      }
    });
    await check('per-document engine wins and 996PC supports verified DELAYCALL but not DELAYGOTO', async () => {
      host.setEngine('996PC');
      const document = makeDocument(`[@main]\n#ACT\nDELAYGOTO 1000 @${target}\n[@${target}]`);
      document.uri.engine = 'GOM';
      assert.ok(await jump(document, 2, document.lineAt(2).text.indexOf('@')));
      document.uri.engine = '996PC';
      assert.equal(await jump(document, 2, document.lineAt(2).text.indexOf('@')), null);
      document.replace(`[@main]\n#ACT\nDELAYCALL 1000 @${target}\n[@${target}]`);
      assert.ok(await jump(document, 2, document.lineAt(2).text.indexOf('@')));
    });
    await check('comments, display text, conditions, dynamic labels and lookalike commands do not navigate', async () => {
      host.setEngine('GOM');
      for (const raw of [
        `; DELAYGOTO 1000 @${target}`, `// DELAYGOTO 1000 @${target}`,
        `SENDMSG 6 示例 DELAYGOTO 1000 @${target}`, `MyDELAYGOTO 1000 @${target}`, `DELAYGOTOEX 1000 @${target}`,
        `#SAY DELAYGOTO 1000 @${target}`, `#IF(DELAYGOTO 1000 @${target})`, `#OR(DELAYCALL 1000 @${target})`,
        `DELAYGOTO 1000 @<$STR(S$目标)>`,
      ]) {
        const document = makeDocument(`[@main]\n#ACT\n${raw}\n[@${target}]\n[@<$STR(S$目标)>]`);
        assert.equal(await jump(document, 2, raw.indexOf('@')), null, raw);
      }
      for (const block of ['#SAY', '#ELSESAY', '#IF', '#OR']) {
        const document = makeDocument(`[@main]\n${block}\nDELAYGOTO 1000 @${target}\n[@${target}]`);
        assert.equal(await jump(document, 2, document.lineAt(2).text.indexOf('@')), null, block);
      }
    });
    await check('unsaved same-document labels are authoritative and removed labels stop resolving', async () => {
      const document = makeDocument(`[@main]\n#ACT\nDELAYGOTO 1000 @${target}\n[@磁盘旧标签]`);
      assert.equal(await jump(document, 2, document.lineAt(2).text.indexOf('@')), null);
      document.replace(`[@main]\n#ACT\nDELAYGOTO 1000 @${target}\n\n  [@${target}]`);
      assert.deepEqual((await jump(document, 2, document.lineAt(2).text.indexOf('@'))).range.start, new TestPosition(4, 2));
      document.replace(`[@main]\n#ACT\nDELAYGOTO 1000 @${target}\n[@已删除]`);
      assert.equal(await jump(document, 2, document.lineAt(2).text.indexOf('@')), null);
      assert.deepEqual(host.sideEffects, [], 'same-file queries never read disk, open documents, or write');
    });
    await check('case-insensitive target lookup skips commented and ordinary-text fake definitions', async () => {
      const document = makeDocument([
        '[@main]', '#ACT', 'DELAYGOTO 1000 @mixed_回调',
        '; [@MIXED_回调]', '// [@MIXED_回调]', 'SENDMSG 6 示例 [@MIXED_回调]', '  [@MIXED_回调]',
      ].join('\r\n'));
      const location = await jump(document, 2, document.lineAt(2).text.indexOf('@'));
      assert.ok(location);
      assert.deepEqual(location.range.start, new TestPosition(6, 2));
    });
    await check('registered References and CodeLens include delayed references but ignore SAY/condition text', async () => {
      const document = makeDocument([
        `[@${target}]`, '#ACT', `DELAYGOTO 1000 @${target}`, `DELAYCALL 2000 @${target}`,
        '#SAY', `DELAYGOTO 1000 @${target}`, '#IF', `DELAYCALL 1000 @${target}`,
      ].join('\r\n'));
      const references = host.providers.Reference.provideReferences(document, new TestPosition(0, 3), {}, {});
      assert.deepEqual(references.map(item => item.range.start.line).sort((a, b) => a - b), [0, 2, 3]);
      const lenses = host.providers.CodeLens.provideCodeLenses(document);
      assert.equal(lenses.length, 1);
      assert.equal(lenses[0].command.title, '2 处引用');
    });
    await check('registered save diagnostics report unresolved delayed labels only in executable contexts', async () => {
      const document = makeDocument([
        '[@main]', '#ACT', 'DELAYGOTO 1000 @确实缺失', '#SAY', 'DELAYCALL 1000 @显示文字',
        '#IF', 'DELAYGOTO 1000 @条件文字', '#ACT', `DELAYCALL 1000 @${target}`, `[@${target}]`,
      ].join('\r\n'));
      for (const callback of host.events.onDidSaveTextDocument || []) await callback(document);
      const issues = (host.diagnostics.get(document.uri.toString()) || []).filter(item => item.message.includes('引用了未定义的标签'));
      assert.deepEqual(issues.map(item => ({ message: item.message, line: item.range.start.line })), [
        { message: '引用了未定义的标签 @确实缺失', line: 2 },
      ]);
    });
    console.log(`delayed-label-definition.test.js: PASS (${cases} cases; production registration, VS Code API stub)`);
  } finally { host.dispose(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
