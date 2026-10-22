const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { removeTemporaryDirectory } = require('./helpers/temp-cleanup');

const runtime = path.resolve(process.env.BOO_SCRIPT_RUNTIME_ROOT || path.join(__dirname, '..'));
let cases = 0;
function check(name, body) { body(); cases++; console.log(`map-config-links: PASS - ${name}`); }
async function checkAsync(name, body) { await body(); cases++; console.log(`map-config-links: PASS - ${name}`); }

class TestUri {
  constructor(value) {
    this.value = value;
    this.scheme = value.split(':')[0];
    this.fsPath = this.scheme === 'file' ? fileURLToPath(value) : '';
  }
  static file(value) { return new TestUri(pathToFileURL(path.resolve(value)).href); }
  static parse(value) { return new TestUri(value); }
  static from(value) { return new TestUri(`${value.scheme}://${value.authority || ''}${value.path || ''}`); }
  toString() { return this.value; }
  toJSON() { return { scheme: this.scheme, path: this.fsPath, fsPath: this.fsPath }; }
}
class TestRange {
  constructor(line, start, endLine, end) { this.start = { line, character: start }; this.end = { line: endLine, character: end }; }
}
class TestLink { constructor(range, target) { this.range = range; this.target = target; } }
class TestEventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }

function makeDocument(fileName, text) {
  return {
    fileName, uri: TestUri.file(fileName), version: 1,
    getText() { return text; },
    get lineCount() { return text.split(/\r?\n|\r/).length; },
    lineAt(index) { return { text: text.split(/\r?\n|\r/)[index] }; },
    replace(value) { text = value; this.version++; },
  };
}
function linkText(document, link) {
  return document.lineAt(link.range.start.line).text.slice(link.range.start.character, link.range.end.character);
}
function argsFor(link) { return JSON.parse(decodeURIComponent(link.target.toString().split('?')[1])); }
function mapBytes(width, height = 1) {
  const data = Buffer.alloc(52 + width * height * 14);
  data.writeUInt16LE(width, 0); data.writeUInt16LE(height, 2);
  return data;
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'boo-map-config-links-'));
  const warnings = [], panels = [], opened = [], scopedConfigs = [];
  const serverA = path.join(temporary, '服一'), serverB = path.join(temporary, '服二');
  const envirA = path.join(serverA, 'Mir200', 'Envir'), envirB = path.join(serverB, 'Mir200', 'Envir');
  for (const envir of [envirA, envirB]) fs.mkdirSync(envir, { recursive: true });
  for (const [server, width] of [[serverA, 1], [serverB, 2]]) {
    fs.mkdirSync(path.join(server, 'Mir200', 'Map'));
    fs.writeFileSync(path.join(server, 'Mir200', 'Map', '0.MAP'), mapBytes(width));
    fs.writeFileSync(path.join(server, 'Mir200', 'Map', 'ERSG.map'), mapBytes(width + 2));
    fs.writeFileSync(path.join(server, 'Mir200', 'Map', 'SHABAK.map'), mapBytes(199 + width, 160));
    fs.writeFileSync(path.join(server, 'Mir200', 'Map', 'PALACE.map'), mapBytes(79 + width, 80));
    fs.writeFileSync(path.join(server, 'Mir200', 'Envir', 'MapInfo.txt'), '[0 磁盘地图]\r\n[D001|ERSG 磁盘副本]');
  }
  const vscode = {
    Uri: TestUri, Range: TestRange, DocumentLink: TestLink,
    EventEmitter: TestEventEmitter, Disposable: class { dispose() {} },
    ViewColumn: { Active: 1 }, FileType: { File: 1, Directory: 2 },
    workspace: {
      workspaceFolders: [{ uri: TestUri.file(temporary) }], textDocuments: [],
      getWorkspaceFolder() { return { uri: TestUri.file(temporary) }; },
      getConfiguration(_section, scope) {
        scopedConfigs.push(scope?.fsPath);
        return { get(key, fallback) { return key === 'engine' ? 'GOM' : fallback; } };
      },
      onDidChangeWorkspaceFolders() { return { dispose() {} }; },
      onDidChangeConfiguration() { return { dispose() {} }; },
      async openTextDocument(uri) {
        opened.push(uri.fsPath);
        const document = makeDocument(uri.fsPath, fs.readFileSync(uri.fsPath, 'utf8'));
        this.textDocuments.push(document); return document;
      },
    },
    window: {
      showWarningMessage(value) { warnings.push(value); },
      createWebviewPanel() {
        const messages = [];
        const panel = {
          messages, revealed: 0, receive: undefined,
          reveal() { this.revealed++; }, onDidDispose() {}, dispose() {},
          webview: {
            cspSource: 'https://test.local', options: {},
            asWebviewUri(uri) { return uri; },
            postMessage(value) { messages.push(value); return Promise.resolve(true); },
            onDidReceiveMessage(callback) { panel.receive = callback; },
          },
        };
        panels.push(panel); return panel;
      },
    },
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { parseMapInfoLine, parseMapInfoText, parseMapInfoConnectionLine } = require(path.join(runtime, 'out/utils/map-preview'));
    const { parseMonGenLine } = require(path.join(runtime, 'out/utils/map-entities'));
    const { MapInfoLinkProvider } = require(path.join(runtime, 'out/providers/map-info-link'));
    const { MonGenLinkProvider } = require(path.join(runtime, 'out/providers/mongen-link'));
    const { MapPreviewProvider } = require(path.join(runtime, 'out/providers/map-preview'));
    const mapLinks = new MapInfoLinkProvider(), monLinks = new MonGenLinkProvider();
    const mapDoc = makeDocument(path.join(envirB, 'MapInfo.txt'), [
      '\uFEFF  [0 长安] DAY ; 长安 outside',
      '\t[D001 | ERSG 长安 副本  ] DARK',
      '[长安 长安] NORECALL',
      ';[2 注释地图]', '//[3 注释地图]', '[4]',
      '[../escape 不安全]', '[D2|<$STR(S1)> 动态]', '长安',
      '[5 长安] DAY',
    ].join('\r\n'));
    check('exact standard, alias, repeated ID/name and repeated display-name spans', () => {
      const links = mapLinks.provideDocumentLinks(mapDoc);
      assert.deepEqual(links.map(link => linkText(mapDoc, link)), ['长安', '长安 副本', '长安', '长安']);
      assert.deepEqual(links.map(link => argsFor(link)), [1, 2, 3, 10].map(line => [mapDoc.uri.toString(), line]));
      assert.ok(links.every(link => link.target.toString().startsWith('command:boo.openMapInfoOriginalMap?')));
      assert.equal(panels.length, 0, 'link lookup never opens a map');
      assert.equal(warnings.length, 0, 'link lookup never prompts');
    });
    check('other files, nested MapInfo and non-file documents have no accidental name links', () => {
      for (const file of [path.join(envirB, 'other.txt'), path.join(envirB, 'QuestDiary', 'MapInfo.txt'), path.join(temporary, 'MapInfo.txt')]) {
        assert.deepEqual(mapLinks.provideDocumentLinks(makeDocument(file, '[0 长安]')), []);
      }
      const document = makeDocument(path.join(envirB, 'MapInfo.txt'), '[0 长安]');
      document.uri = TestUri.parse('untitled:MapInfo.txt');
      assert.deepEqual(mapLinks.provideDocumentLinks(document), []);
    });
    check('single-line helper and catalogue share semantics without linking fallback names', () => {
      const raw = '\t [D001|ERSG 长安副本] DARK';
      const parsed = parseMapInfoLine(raw, 7);
      assert.equal(raw.slice(parsed.nameSpan.start, parsed.nameSpan.end), '长安副本');
      assert.deepEqual(parseMapInfoText(raw)[0], { ...parsed.entry, key: '1:D001', lineNumber: 1 });
      assert.equal(parseMapInfoLine('[0]', 1).nameSpan, undefined);
    });
    check('connection parser returns exact complete endpoint spans with BOM, indentation and comma spacing', () => {
      const raw = '\uFEFF\t  沙巴克 150 , 122  ->  皇宫 11, 30 \t; 沙巴克 99,99 -> 皇宫 9,9';
      const fromText = '沙巴克 150 , 122', toText = '皇宫 11, 30';
      const parsed = parseMapInfoConnectionLine(raw, 19);
      assert.deepEqual(parsed, {
        lineNumber: 19,
        from: { mapId: '沙巴克', x: 150, y: 122, span: { start: raw.indexOf(fromText), end: raw.indexOf(fromText) + fromText.length } },
        to: { mapId: '皇宫', x: 11, y: 30, span: { start: raw.indexOf(toText), end: raw.indexOf(toText) + toText.length } },
      });
      assert.equal(raw.slice(parsed.from.span.start, parsed.from.span.end), fromText);
      assert.equal(raw.slice(parsed.to.span.start, parsed.to.span.end), toText);
      const zeros = parseMapInfoConnectionLine('$d001 0,00 -> ERSG 001,002 // trailing comment', 1);
      assert.equal(zeros.from.mapId, '$d001');
      assert.deepEqual([zeros.from.x, zeros.from.y, zeros.to.x, zeros.to.y], [0, 0, 1, 2]);
      assert.equal(parseMapInfoConnectionLine(`0 ${Number.MAX_SAFE_INTEGER},0 -> 1 0,0`, 1).from.x, Number.MAX_SAFE_INTEGER);
      for (const [line, from, to] of [
        ['九曲黄河阵1 181 109 -> 九曲黄河阵3 154 65', '九曲黄河阵1 181 109', '九曲黄河阵3 154 65'],
        ['  沙巴克 150,122 -> 皇宫\t11\t30 // comment', '沙巴克 150,122', '皇宫\t11\t30'],
        ['\t沙巴克 150 122  ->  皇宫 11 , 30 ; comment', '沙巴克 150 122', '皇宫 11 , 30'],
      ]) {
        const connection = parseMapInfoConnectionLine(line, 5);
        assert.equal(connection.lineNumber, 5);
        assert.equal(line.slice(connection.from.span.start, connection.from.span.end), from);
        assert.equal(line.slice(connection.to.span.start, connection.to.span.end), to);
        assert.deepEqual([connection.from.x, connection.from.y], from.includes('181') ? [181, 109] : [150, 122]);
        assert.deepEqual([connection.to.x, connection.to.y], to.includes('154') ? [154, 65] : [11, 30]);
      }
    });
    const invalidConnections = [
      '', ';沙巴克 150,122 -> 皇宫 11,30', ' // 沙巴克 150,122 -> 皇宫 11,30',
      '沙巴克 -1,122 -> 皇宫 11,30', '沙巴克 1.5,122 -> 皇宫 11,30',
      '沙巴克 1e2,122 -> 皇宫 11,30', '沙巴克 +1,122 -> 皇宫 11,30',
      '沙巴克 150,122 -> 皇宫 11,-1', '沙巴克 150,122 -> 皇宫 11,30.5',
      `沙巴克 ${Number.MAX_SAFE_INTEGER + 1},122 -> 皇宫 11,30`,
      '沙巴克 150,122 => 皇宫 11,30',
      '沙巴克 150,122 -> 皇宫', '沙巴克 150,122 -> 皇宫 11,30 extra',
      '沙巴克 150 122 3 -> 皇宫 11 30', '沙巴克 150 122 -> 皇宫 11 30 4',
      '沙巴克 150,122 -> 皇宫 11,30 -> 0 1,2',
      '../沙巴克 150,122 -> 皇宫 11,30', '沙巴克 150,122 -> 目录\\皇宫 11,30',
      '<$STR(S0)> 150,122 -> 皇宫 11,30', '沙巴克 150,122 -> D001|ERSG 11,30',
      '[沙巴克 沙巴克] 150,122 -> 皇宫 11,30',
    ];
    check('connection parser refuses dynamic, unsafe, malformed, negative and non-integer endpoints', () => {
      for (const raw of invalidConnections) assert.equal(parseMapInfoConnectionLine(raw, 1), undefined, raw);
    });
    check('connection links cover each full endpoint, retain header command arguments and have no hover side effects', () => {
      const document = makeDocument(path.join(envirB, 'MapInfo.txt'), [
        '[沙巴克|SHABAK 沙巴克]',
        '\uFEFF\t沙巴克 150 , 122 -> 皇宫 11, 30 // not another link',
        '0 0,0 -> $D001 1,2 ; comment',
        '九曲黄河阵1 181 109 -> 九曲黄河阵3 154,65',
        ...invalidConnections.filter(raw => !raw.startsWith('[')),
      ].join('\r\n'));
      const before = { panels: panels.length, warnings: warnings.length, opened: opened.length };
      const links = mapLinks.provideDocumentLinks(document);
      assert.deepEqual(links.map(link => linkText(document, link)), [
        '沙巴克', '沙巴克 150 , 122', '皇宫 11, 30', '0 0,0', '$D001 1,2',
        '九曲黄河阵1 181 109', '九曲黄河阵3 154,65',
      ]);
      assert.deepEqual(links.map(argsFor), [
        [document.uri.toString(), 1],
        [document.uri.toString(), 2, 'from'], [document.uri.toString(), 2, 'to'],
        [document.uri.toString(), 3, 'from'], [document.uri.toString(), 3, 'to'],
        [document.uri.toString(), 4, 'from'], [document.uri.toString(), 4, 'to'],
      ]);
      assert.ok(links.every(link => link.target.toString().startsWith('command:boo.openMapInfoOriginalMap?')));
      assert.deepEqual({ panels: panels.length, warnings: warnings.length, opened: opened.length }, before);
      for (const file of [path.join(envirB, 'other.txt'), path.join(envirB, 'QuestDiary', 'MapInfo.txt')]) {
        assert.deepEqual(mapLinks.provideDocumentLinks(makeDocument(file, '沙巴克 150,122 -> 皇宫 11,30')), []);
      }
    });
    const monDoc = makeDocument(path.join(envirB, 'MonGen.txt'), [
      '\uFEFF\tD001 152 97 练功师 0 1 1 ;练功师 outside',
      ';0 1 2 注释 3 1', '//0 1 2 注释 3 1',
      '0 1 2 <$STR(S1)> 3 1', '0 1 2 ../逃逸 3 1',
    ].join('\r\n'));
    check('MonGen links only map and monster columns, without creating missing MonItems', () => {
      const links = monLinks.provideDocumentLinks(monDoc);
      assert.deepEqual(links.map(link => linkText(monDoc, link)), ['D001', '练功师', '0', '0']);
      assert.equal(links[0].target.toString().split('?')[0], 'command:boo.openMonGenOriginalMap');
      assert.equal(links[1].target.toString().split('?')[0], 'command:boo.createMissingFile');
      assert.equal(argsFor(links[1])[1], '练功师');
      assert.equal(argsFor(links[1])[2], 'monGen');
      assert.equal(argsFor(links[1])[3], 1);
      assert.equal(fs.existsSync(path.join(envirB, 'MonItems')), false);
      const parsed = parseMonGenLine(monDoc.lineAt(0).text, 1);
      assert.equal(parsed.spawn.mapName, 'D001');
      assert.equal(monDoc.lineAt(0).text.slice(parsed.columns[3].start, parsed.columns[3].end), '练功师');
    });
    check('nested or foreign MonGen files cannot generate map or drop-file links', () => {
      for (const file of [path.join(envirB, 'QuestDiary', 'MonGen.txt'), path.join(temporary, 'MonGen.txt')]) {
        assert.deepEqual(monLinks.provideDocumentLinks(makeDocument(file, '0 152 97 练功师 0 1 1')), []);
      }
    });
    check('escaped MonItems junction blocks drop-file links but does not hide valid map links', () => {
      const envir = path.join(temporary, 'unsafe-drops', 'Mir200', 'Envir');
      const outside = path.join(temporary, 'outside-drops');
      fs.mkdirSync(envir, { recursive: true }); fs.mkdirSync(outside);
      const junction = path.join(envir, 'MonItems');
      fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        const document = makeDocument(path.join(envir, 'MonGen.txt'), '0 152 97 练功师 0 1 1');
        const links = monLinks.provideDocumentLinks(document);
        assert.equal(links.length, 1);
        assert.equal(linkText(document, links[0]), '0');
        assert.equal(links[0].target.toString().split('?')[0], 'command:boo.openMonGenOriginalMap');
        assert.deepEqual(fs.readdirSync(outside), []);
      } finally { process.platform === 'win32' ? fs.rmdirSync(junction) : fs.unlinkSync(junction); }
    });
    check('existing drop file links prefer own server, case insensitive and preserve original bytes', () => {
      const dropsA = path.join(envirA, 'MonItems'), dropsB = path.join(envirB, 'monitems');
      fs.mkdirSync(dropsA); fs.mkdirSync(dropsB);
      fs.writeFileSync(path.join(dropsA, '练功师.txt'), 'wrong server');
      const own = path.join(dropsB, '练功师.TXT'); fs.writeFileSync(own, 'existing drop');
      const monster = monLinks.provideDocumentLinks(monDoc).find(link => linkText(monDoc, link) === '练功师');
      assert.equal(monster.target.fsPath, own);
      assert.equal(fs.readFileSync(own, 'utf8'), 'existing drop');
    });
    check('5387-row DocumentLink query enumerates Envir and MonItems once each', () => {
      const document = makeDocument(path.join(envirB, 'MonGen.txt'), Array.from({ length: 5387 }, () => '0 152 97 练功师 0 1 1').join('\n'));
      const readdir = fs.readdirSync;
      let directoryReads = 0;
      fs.readdirSync = function(file, options) {
        if ([envirB, path.join(envirB, 'monitems')].includes(file)) directoryReads++;
        return readdir.call(this, file, options);
      };
      try {
        assert.equal(monLinks.provideDocumentLinks(document).length, 5387 * 2);
        assert.equal(directoryReads, 2, 'no per-row directory scan');
      } finally { fs.readdirSync = readdir; }
    });
    const state = { get(_key, fallback) { return fallback; }, async update() {} };
    const provider = new MapPreviewProvider({
      extensionPath: runtime, extensionUri: TestUri.file(runtime),
      globalStorageUri: TestUri.file(path.join(temporary, 'storage')),
      globalState: state, workspaceState: state, subscriptions: [],
    });
    const entityRoots = [];
    provider.clientResourceLayout = () => undefined;
    provider.resolveMiniMapImage = () => undefined;
    provider.readMapEntities = root => {
      entityRoots.push(root);
      return { npcs: [], spawns: [], safeZones: [], resourceRoots: [], warnings: [] };
    };
    const dirtyA = makeDocument(path.join(envirA, 'MapInfo.txt'), '[0 脏地图甲]\r\n[D001|ERSG 脏副本甲]');
    const dirtyB = makeDocument(path.join(envirB, 'MapInfo.txt'), '[0 脏地图乙]\r\n[D001|ERSG 脏副本乙]');
    vscode.workspace.textDocuments.push(dirtyA, dirtyB, monDoc);
    await checkAsync('click reads dirty source and selects original mode via existing load protocol', async () => {
      await provider.revealMapInfoOriginalMap(dirtyA.uri.toString(), 1);
      assert.equal(opened.length, 0, 'already-open dirty text is authoritative');
      assert.equal(provider.currentMap.name, '脏地图甲');
      const panel = panels[0]; panel.receive({ type: 'ready' });
      const data = panel.messages.find(message => message.type === 'mapData');
      assert.equal(data.originalMap, true);
      assert.equal(data.map.width, 1);
      assert.equal(entityRoots.at(-1), serverA);
      await provider.loadOriginalMap({ requestId: 1 });
      assert.equal(provider.originalMapSession.filePath.toLowerCase(), path.join(serverA, 'Mir200', 'Map', '0.map').toLowerCase());
    });
    await checkAsync('same-key map in second server invalidates the first session and never borrows its file', async () => {
      const previous = provider.originalMapSession;
      await provider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 1);
      assert.equal(provider.currentMap.name, '脏地图乙');
      assert.equal(provider.originalMapSession, undefined);
      assert.equal(entityRoots.at(-1), serverB);
      await provider.loadOriginalMap({ requestId: 2 });
      assert.notEqual(provider.originalMapSession, previous);
      assert.equal(provider.originalMapSession.model.width, 2);
      assert.ok(scopedConfigs.includes(dirtyB.fileName));
    });
    await checkAsync('queued marker and entity writes cannot cross a same-key server switch', async () => {
      const originalRoot = provider.sourceWorkspaceRoot, originalMap = provider.currentMap;
      let markerWrites = 0;
      provider.saveMarkerUpdate = () => { markerWrites++; return {}; };
      provider.saveMarkerAdditions = () => { markerWrites++; return []; };
      provider.enqueueMarkerUpdate({ requestId: 40 });
      provider.enqueueMarkerAddition({ requestId: 41 });
      provider.enqueueNpcUpdate({ requestId: 42 });
      provider.enqueueSpawnUpdate({ requestId: 43 });
      provider.sourceWorkspaceRoot = serverA;
      provider.currentMap = { ...originalMap }; // Same line number/map ID is not a server identity.
      await provider.markerSaveQueue; await provider.entitySaveQueue;
      assert.equal(markerWrites, 0);
      const failed = panels[0].messages.filter(message => [40, 41, 42, 43].includes(message.requestId));
      assert.equal(failed.length, 4);
      assert.ok(failed.every(message => /切换/.test(message.message)));
      provider.sourceWorkspaceRoot = originalRoot; provider.currentMap = originalMap;
    });
    await checkAsync('instance ID resolves real map filename, not a same-name map from another server', async () => {
      await provider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 2);
      await provider.loadOriginalMap({ requestId: 3 });
      assert.equal(provider.currentMap.mapId, 'D001');
      assert.equal(provider.currentMap.originalMapId, 'ERSG');
      assert.equal(provider.originalMapSession.model.width, 4);
      assert.equal(path.basename(provider.originalMapSession.filePath), 'ERSG.map');
    });
    await checkAsync('repeated ready-map clicks reveal without restarting a valid original session', async () => {
      const session = provider.originalMapSession;
      const count = panels[0].messages.filter(message => message.type === 'mapData').length;
      await provider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 2);
      assert.equal(provider.originalMapSession, session);
      assert.equal(panels[0].messages.at(-1).type, 'revealOriginalMap');
      assert.equal(panels[0].messages.filter(message => message.type === 'mapData').length, count);
    });
    await checkAsync('dirty alias target change invalidates same-key cached session', async () => {
      dirtyB.replace('[0 脏地图乙]\r\n[D001|0 修改副本]');
      await provider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 2);
      assert.equal(provider.currentMap.originalMapId, '0');
      assert.equal(provider.originalMapSession, undefined);
      await provider.loadOriginalMap({ requestId: 4 });
      assert.equal(provider.originalMapSession.model.width, 2);
    });
    await checkAsync('MonGen map command shares dirty MapInfo and original renderer without text-name guessing', async () => {
      dirtyB.replace('[0 脏地图乙]\r\n[D001|ERSG 最新副本]');
      await provider.revealMonGenOriginalMap(monDoc.uri.toString(), 1);
      assert.equal(provider.currentMap.name, '最新副本');
      await provider.loadOriginalMap({ requestId: 5 });
      assert.equal(provider.originalMapSession.model.width, 4);
      monDoc.replace('不存在 152 97 练功师 0 1 1');
      await provider.revealMonGenOriginalMap(monDoc.uri.toString(), 1);
      assert.match(warnings.at(-1), /当前服务端 MapInfo/);
    });
    await checkAsync('map ID matching normalizes both dollar prefixes without selecting same display names', async () => {
      dirtyB.replace('[FAKE D001]\r\n[$D001|ERSG 正确副本]');
      monDoc.replace('$d001 152 97 练功师 0 1 1');
      await provider.revealMonGenOriginalMap(monDoc.uri.toString(), 1);
      assert.equal(provider.currentMap.mapId, '$D001');
      assert.equal(provider.currentMap.name, '正确副本');
      await provider.loadOriginalMap({ requestId: 6 });
      assert.equal(path.basename(provider.originalMapSession.filePath), 'ERSG.map');
    });
    await checkAsync('stale or invalid clicked definitions are rejected without replacing the current map', async () => {
      const current = provider.currentMap, panelCount = panels.length;
      dirtyB.replace('[0 脏地图乙]\r\n;[D001|ERSG 已删除副本]');
      await provider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 2);
      await provider.revealMapInfoOriginalMap(path.join(temporary, 'MapInfo.txt'), 1);
      await provider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 0);
      assert.equal(provider.currentMap, current);
      assert.equal(panels.length, panelCount);
      assert.ok(warnings.length >= 4);
    });
    const connectionProvider = new MapPreviewProvider({
      extensionPath: runtime, extensionUri: TestUri.file(runtime),
      globalStorageUri: TestUri.file(path.join(temporary, 'connection-storage')),
      globalState: state, workspaceState: state, subscriptions: [],
    });
    connectionProvider.clientResourceLayout = () => undefined;
    connectionProvider.resolveMiniMapImage = () => undefined;
    connectionProvider.readMapEntities = root => {
      entityRoots.push(root);
      return { npcs: [], spawns: [], safeZones: [], resourceRoots: [], warnings: [] };
    };
    const connectionText = line => `[沙巴克|SHABAK 同名地点]\r\n[皇宫|PALACE 同名地点]\r\n${line}`;
    let connectionPanel;
    await checkAsync('first connection click opens original mode with a point, from current dirty MapInfo instead of disk', async () => {
      dirtyA.replace(connectionText('沙巴克 150,122 -> 皇宫 11,30'));
      await connectionProvider.revealMapInfoOriginalMap(dirtyA.uri.toString(), 3, 'from');
      assert.equal(connectionProvider.currentMap.mapId, '沙巴克');
      assert.equal(connectionProvider.currentMap.originalMapId, 'SHABAK');
      assert.equal(connectionProvider.sourceWorkspaceRoot, serverA);
      assert.equal(opened.length, 0, 'connection command must use already-open dirty text');
      connectionPanel = panels.at(-1);
      assert.notEqual(connectionPanel, panels[0]);
      connectionPanel.receive({ type: 'ready' });
      const data = connectionPanel.messages.find(message => message.type === 'mapData');
      assert.equal(data.originalMap, true);
      assert.deepEqual(data.revealPoint, { x: 150, y: 122 });
      assert.deepEqual([data.map.width, data.map.height], [200, 160]);
      assert.equal(entityRoots.at(-1), serverA);
      await connectionProvider.loadOriginalMap({ requestId: 101 });
      assert.equal(path.basename(connectionProvider.originalMapSession.filePath), 'SHABAK.map');
    });
    await checkAsync('right endpoint opens its own original map and carries its own coordinates', async () => {
      await connectionProvider.revealMapInfoOriginalMap(dirtyA.uri.toString(), 3, 'to');
      assert.equal(connectionProvider.currentMap.mapId, '皇宫');
      assert.equal(connectionProvider.currentMap.originalMapId, 'PALACE');
      const data = connectionPanel.messages.filter(message => message.type === 'mapData').at(-1);
      assert.equal(data.originalMap, true);
      assert.deepEqual(data.revealPoint, { x: 11, y: 30 });
      await connectionProvider.loadOriginalMap({ requestId: 102 });
      assert.equal(path.basename(connectionProvider.originalMapSession.filePath), 'PALACE.map');
    });
    await checkAsync('ready same-map endpoint clicks preserve loaded session, zero coordinates and every new point', async () => {
      dirtyA.replace(connectionText('皇宫 0,0 -> 皇宫 79,79'));
      const session = connectionProvider.originalMapSession;
      const mapDataCount = connectionPanel.messages.filter(message => message.type === 'mapData').length;
      for (const [side, point] of [['from', { x: 0, y: 0 }], ['to', { x: 79, y: 79 }], ['from', { x: 0, y: 0 }]]) {
        await connectionProvider.revealMapInfoOriginalMap(dirtyA.uri.toString(), 3, side);
        assert.deepEqual(connectionPanel.messages.at(-1), { type: 'revealOriginalMap', point });
        assert.equal(connectionProvider.originalMapSession, session);
        assert.equal(connectionPanel.messages.filter(message => message.type === 'mapData').length, mapDataCount);
      }
    });
    await checkAsync('click command re-parses a dirty connection changed after link discovery', async () => {
      dirtyA.replace(connectionText('沙巴克 150,122 -> 皇宫 11,30'));
      const link = mapLinks.provideDocumentLinks(dirtyA).find(value => argsFor(value)[2] === 'from');
      const argumentsAtDiscovery = argsFor(link);
      dirtyA.replace(connectionText('皇宫 12 31 -> 沙巴克 151,123'));
      await connectionProvider.revealMapInfoOriginalMap(...argumentsAtDiscovery);
      assert.equal(connectionProvider.currentMap.mapId, '皇宫');
      assert.deepEqual(connectionPanel.messages.at(-1), { type: 'revealOriginalMap', point: { x: 12, y: 31 } });
    });
    await checkAsync('same connection IDs in another server invalidate assets and locate only that server map', async () => {
      dirtyA.replace(connectionText('沙巴克 150,122 -> 皇宫 11,30'));
      await connectionProvider.revealMapInfoOriginalMap(dirtyA.uri.toString(), 3, 'from');
      await connectionProvider.loadOriginalMap({ requestId: 103 });
      const previous = connectionProvider.originalMapSession;
      dirtyB.replace(connectionText('沙巴克 150,122 -> 皇宫 11,30'));
      await connectionProvider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 3, 'from');
      assert.equal(connectionProvider.originalMapSession, undefined);
      assert.equal(connectionProvider.sourceWorkspaceRoot, serverB);
      const data = connectionPanel.messages.filter(message => message.type === 'mapData').at(-1);
      assert.equal(data.originalMap, true);
      assert.deepEqual(data.revealPoint, { x: 150, y: 122 });
      assert.equal(data.map.width, 201);
      assert.equal(entityRoots.at(-1), serverB);
      await connectionProvider.loadOriginalMap({ requestId: 104 });
      assert.notEqual(connectionProvider.originalMapSession, previous);
      assert.equal(connectionProvider.originalMapSession.model.width, 201);
      assert.ok(connectionProvider.originalMapSession.filePath.startsWith(serverB));
    });
    await checkAsync('connection ID resolution normalizes case and dollars, prefers actual IDs and only then original IDs', async () => {
      dirtyB.replace([
        '[别的实例|ERSG 不能抢实际ID]',
        '[$D001|SHABAK 正确副本]',
        '[FAKE D001]',
        '[$ERSG|PALACE 实际ID优先]',
        '$d001 1,2 -> ersg 3,4',
      ].join('\r\n'));
      await connectionProvider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 5, 'from');
      assert.equal(connectionProvider.currentMap.mapId, '$D001');
      assert.equal(connectionProvider.currentMap.name, '正确副本');
      await connectionProvider.loadOriginalMap({ requestId: 105 });
      assert.equal(path.basename(connectionProvider.originalMapSession.filePath), 'SHABAK.map');
      await connectionProvider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 5, 'to');
      assert.equal(connectionProvider.currentMap.mapId, '$ERSG');
      assert.equal(connectionProvider.currentMap.originalMapId, 'PALACE');
      assert.deepEqual(connectionPanel.messages.filter(message => message.type === 'mapData').at(-1).revealPoint, { x: 3, y: 4 });
      dirtyB.replace('[D001|SHABAK 原图回退]\r\nshabak 1,2 -> SHABAK 3,4');
      await connectionProvider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 2, 'from');
      assert.equal(connectionProvider.currentMap.mapId, 'D001');
      assert.equal(connectionProvider.currentMap.originalMapId, 'SHABAK');
    });
    await checkAsync('stale connection, invalid side, undefined IDs, display-name guesses and out-of-bounds points leave valid view intact', async () => {
      dirtyB.replace(connectionText('沙巴克 150,122 -> 皇宫 11,30'));
      await connectionProvider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 3, 'from');
      await connectionProvider.loadOriginalMap({ requestId: 106 });
      const current = connectionProvider.currentMap;
      const session = connectionProvider.originalMapSession;
      const root = connectionProvider.sourceWorkspaceRoot;
      const panelCount = panels.length;
      const messages = connectionPanel.messages.length;
      const assertRejected = async (text, line, side, source = dirtyB) => {
        source.replace(text);
        const warningCount = warnings.length;
        await connectionProvider.revealMapInfoOriginalMap(source.uri.toString(), line, side);
        assert.equal(connectionProvider.currentMap, current, `${String(side)} / ${text}`);
        assert.equal(connectionProvider.originalMapSession, session);
        assert.equal(connectionProvider.sourceWorkspaceRoot, root);
        assert.equal(panels.length, panelCount);
        assert.equal(connectionPanel.messages.length, messages, 'invalid commands must not send map/reveal data');
        assert.ok(warnings.length > warningCount, 'invalid explicit clicks should explain rejection');
      };
      for (const side of ['', 'FROM', 'left', 0, null, {}]) {
        await assertRejected(connectionText('沙巴克 150,122 -> 皇宫 11,30'), 3, side);
      }
      await assertRejected(connectionText(';沙巴克 150,122 -> 皇宫 11,30'), 3, 'from');
      await assertRejected(connectionText('沙巴克 150,122 -> 皇宫 11,30'), 0, 'from');
      await assertRejected(connectionText('沙巴克 150,122 -> 皇宫 11,30'), 4, 'from');
      await assertRejected(connectionText('不存在 1,2 -> 皇宫 11,30'), 3, 'from');
      await assertRejected(connectionText('同名地点 1,2 -> 皇宫 11,30'), 3, 'from');
      await assertRejected(connectionText('沙巴克 201,122 -> 皇宫 11,30'), 3, 'from');
      await assertRejected(connectionText('沙巴克 150,160 -> 皇宫 11,30'), 3, 'from');
      await assertRejected(connectionText('沙巴克 150,122 -> 皇宫 81,0'), 3, 'to');
      await assertRejected(connectionText('沙巴克 150,122 -> 皇宫 11,30'), 1, 'from');
      await assertRejected(connectionText('不存在 1,2 -> 不存在 3,4'), 3, 'from', dirtyA);
    });
    await checkAsync('declared connection with a missing original MAP does not change a valid view or server binding', async () => {
      const current = connectionProvider.currentMap;
      const session = connectionProvider.originalMapSession;
      const root = connectionProvider.sourceWorkspaceRoot;
      const panelCount = panels.length, messageCount = connectionPanel.messages.length, warningCount = warnings.length;
      dirtyA.replace('[已声明|MISSING_CONNECTION_MAP 不存在的原图]\r\n已声明 1,2 -> 已声明 3,4');
      await connectionProvider.revealMapInfoOriginalMap(dirtyA.uri.toString(), 2, 'from');
      assert.equal(connectionProvider.currentMap, current);
      assert.equal(connectionProvider.originalMapSession, session);
      assert.equal(connectionProvider.sourceWorkspaceRoot, root);
      assert.equal(panels.length, panelCount);
      assert.equal(connectionPanel.messages.length, messageCount);
      assert.ok(warnings.length > warningCount);
      assert.match(warnings.at(-1), /原始.*地图|地图.*文件|MAP/i);
    });
    await checkAsync('manual sidebar map selection cancels a pending connection reveal before webview readiness', async () => {
      dirtyB.replace(connectionText('沙巴克 150,122 -> 皇宫 11,30'));
      const pendingProvider = new MapPreviewProvider({
        extensionPath: runtime, extensionUri: TestUri.file(runtime),
        globalStorageUri: TestUri.file(path.join(temporary, 'pending-storage')),
        globalState: state, workspaceState: state, subscriptions: [],
      });
      pendingProvider.clientResourceLayout = () => undefined;
      pendingProvider.resolveMiniMapImage = () => undefined;
      pendingProvider.readMapEntities = () => ({ npcs: [], spawns: [], safeZones: [], resourceRoots: [], warnings: [] });
      await pendingProvider.revealMapInfoOriginalMap(dirtyB.uri.toString(), 3, 'from');
      const panel = panels.at(-1);
      assert.equal(pendingProvider.panelReady, false);
      assert.equal(panel.messages.filter(message => message.type === 'mapData').length, 0);
      const sourceMap = pendingProvider.maps.find(map => map.mapId === '沙巴克');
      const otherMap = pendingProvider.maps.find(map => map.mapId === '皇宫');
      await pendingProvider.handleSidebarMessage({ type: 'openMap', key: otherMap.key });
      await pendingProvider.handleSidebarMessage({ type: 'openMap', key: sourceMap.key });
      panel.receive({ type: 'ready' });
      const data = panel.messages.find(message => message.type === 'mapData');
      assert.equal(data.map.mapId, '沙巴克');
      assert.equal(data.originalMap, false, 'manual selection must not reactivate the old connection intent');
      assert.equal(data.revealPoint, undefined, 'late readiness must not replay cancelled coordinates');
    });
    console.log(`map-config-links.test.js: PASS (${cases} behavior cases)`);
  } finally {
    Module._load = originalLoad;
    removeTemporaryDirectory(temporary);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
