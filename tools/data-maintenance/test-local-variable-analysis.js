#!/usr/bin/env node
// Read-only local acceptance: node tools/data-maintenance/test-local-variable-analysis.js --root D:\MirServer --output artifacts/<unique-name>.json
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');

const repository = path.resolve(__dirname, '../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const key = file => path.resolve(file).toLowerCase();
const group = (items, select) => {
  const result = {};
  for (const item of items) { const name = select(item); result[name] = (result[name] || 0) + 1; }
  return result;
};
const inside = (file, root) => {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

function argumentsForRun() {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index];
    if (option === '--help') {
      process.stdout.write('Usage: node tools/data-maintenance/test-local-variable-analysis.js --root <explicit-server-root> [--output <new-json-under-workspace-artifacts>]\nRoot may also be supplied as BOO_VARIABLE_ANALYSIS_ROOT. No server process is started; no server file is written.\n');
      process.exit(0);
    }
    if (!['--root', '--output'].includes(option) || !process.argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${option}`);
    options[option.slice(2)] = process.argv[++index];
  }
  if (!options.root) options.root = process.env.BOO_VARIABLE_ANALYSIS_ROOT;
  if (!options.root) throw new Error('Explicit --root or BOO_VARIABLE_ANALYSIS_ROOT is required; there is no default server directory');
  options.root = path.resolve(options.root);
  if (!fs.statSync(options.root).isDirectory()) throw new Error('Root must be an existing server directory');
  if (options.output) {
    options.output = path.resolve(repository, options.output);
    const artifacts = path.join(repository, 'artifacts');
    if (!inside(options.output, artifacts) || options.output === artifacts || path.extname(options.output).toLowerCase() !== '.json') throw new Error('--output must name a JSON file inside this workspace artifacts directory');
    if (fs.existsSync(options.output)) throw new Error('Output already exists; choose a fresh evidence filename');
    let ancestor = path.dirname(options.output);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (!inside(fs.realpathSync(ancestor), fs.realpathSync(repository))) throw new Error('Output ancestor resolves outside this workspace');
    if (fs.existsSync(artifacts) && !inside(fs.realpathSync(ancestor), fs.realpathSync(artifacts))) throw new Error('Output ancestor resolves outside the artifacts directory');
    if (inside(options.output, options.root)) throw new Error('Output must not be inside the server root');
  }
  return options;
}

function extractAssistantFunctions(source, names) {
  const ast = ts.createSourceFile('assistant.ts', source, ts.ScriptTarget.Latest, true);
  const required = new Set(names), functions = [];
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name && required.has(node.name.text)) {
      required.delete(node.name.text); functions.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (required.size) throw new Error(`Actual assistant functions missing: ${[...required].join(', ')}`);
  return functions.join('\n');
}

async function main() {
  const options = argumentsForRun(), started = performance.now();
  const text = require('../../out/utils/text');
  const detection = require('../../out/utils/engine-detect').detectEngineDetails(options.root);
  if (!detection.engine) throw new Error('Engine evidence is ambiguous; this audit will not guess GOM/GEE/996PC semantics');
  const engine = detection.engine;
  const nested = require('../../out/utils/nested-variable-analysis');
  const candidates = require('../../out/utils/variable-candidates');
  const maps = require('../../out/utils/map-code-context');
  const { buildLanguageIndex } = require('../../out/utils/command-index');
  const { isScriptCommentLine } = require('../../out/utils/script-labels');
  const tableReader = require('../../out/utils/statistics-table-data');
  const readJson = file => JSON.parse(fs.readFileSync(path.join(repository, file), 'utf8'));
  const catalogFiles = ['data/commands.json', 'data/variables.json', 'data/functions.json', 'data/functions-gee.json', 'data/functions-996pc.json'];
  const language = buildLanguageIndex(readJson(catalogFiles[0]), readJson(catalogFiles[1]), {
    GOM: readJson(catalogFiles[2]), GEE: readJson(catalogFiles[3]), '996PC': readJson(catalogFiles[4]),
  }, engine);
  const fileManifest = new Map(), files = [], directoryErrors = [], skippedLinks = [];
  function remember(file, role, bytes) {
    const full = path.resolve(file), id = key(full), raw = bytes || fs.readFileSync(full), sha256 = hash(raw);
    let record = fileManifest.get(id);
    if (!record) {
      record = { file: full, roles: [], bytes: raw.length, sha256Before: sha256, baseline: role === 'script' || role === 'mapInfo' ? 'before-scan' : 'first-actual-dependency-read', changesDuringReads: false };
      fileManifest.set(id, record);
    } else if (record.sha256Before !== sha256) record.changesDuringReads = true;
    if (!record.roles.includes(role)) record.roles.push(role);
    return record;
  }
  function walk(directory) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') directoryErrors.push({ directory, error: String(error) }); return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { skippedLinks.push(file); continue; }
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(txt|ini)$/i.test(entry.name)) files.push(file);
    }
  }
  // Load after the wrapper below: the scanner still calls the unmodified
  // production analyzer, with observation of its exact returned object only.
  let currentFile;
  const analyses = [], referenceSamples = { resolved: [], partial: [], unresolved: [] };
  const flagSamples = { resolved: [], partial: [], unresolved: [] };
  const uncertainExpected = new Set();
  let flagsUncertainExpected = false;
  const originalAnalyze = nested.analyzeNestedVariables;
  nested.analyzeNestedVariables = function(...args) {
    const start = performance.now(), result = originalAnalyze.apply(this, args);
    const record = { file: path.relative(options.root, currentFile || ''), analysisMs: Math.round((performance.now() - start) * 1000) / 1000,
      nested: group(result.references, ref => ref.status), personalFlags: group(result.personalFlags, ref => ref.status),
      nestedOccurrences: result.references.length, flagOccurrences: result.personalFlags.length,
      nestedConcreteSlots: result.references.reduce((total, ref) => total + ref.variables.length, 0),
      flagConcreteSlots: result.personalFlags.reduce((total, ref) => total + ref.flags.length, 0),
      reasonCounts: group([...result.references, ...result.personalFlags].flatMap(ref => ref.reasons || []), value => value) };
    analyses.push(record);
    for (const ref of result.references) {
      if (referenceSamples[ref.status].length < 8) referenceSamples[ref.status].push({ file: record.file, line: ref.line + 1,
        expression: ref.raw.slice(0, 160), base: ref.base, depth: ref.depth, variables: ref.variables.slice(0, 24),
        valueCount: ref.variables.length, reasons: ref.reasons, trace: ref.trace?.slice(-8) });
      const family = /^([UTAG])\d*$/i.exec(ref.base);
      if (family && ref.status !== 'resolved') uncertainExpected.add(family[1].toUpperCase());
    }
    for (const ref of result.personalFlags) {
      if (flagSamples[ref.status].length < 8) flagSamples[ref.status].push({ file: record.file, line: ref.line + 1,
        expression: nested.normalizePersonalFlagReference(ref).slice(0, 160), flags: ref.flags.slice(0, 24), valueCount: ref.flags.length, reasons: ref.reasons });
      if (ref.status !== 'resolved') flagsUncertainExpected = true;
    }
    if (analyses.length % 100 === 0) process.stderr.write(`Analyzed ${analyses.length}/${files.length} scripts (${Math.round((performance.now() - started) / 1000)} s)\n`);
    return result;
  };
  const { VariableListScanner, variableListScanRoots } = require('../../out/utils/variable-list');
  const scanRoots = variableListScanRoots([options.root]);
  for (const directory of scanRoots) walk(directory);
  if (!files.length) throw new Error('No scripts found in the production five-script-tree scope');
  for (const file of files) {
    const raw = fs.readFileSync(file), record = remember(file, 'script', raw);
    record.encoding = text.decodeTextFile(raw).encoding;
  }
  const mapInfoFiles = [...new Set(scanRoots.map(directory => path.join(path.dirname(directory), 'MapInfo.txt')))].filter(file => fs.existsSync(file));
  for (const file of mapInfoFiles) remember(file, 'mapInfo');
  const resolverCalls = [], resolverLogs = [];
  let activeReadRole = 'dependency';
  const readOnlyFs = { ...fs, readFileSync(file, ...args) {
    const raw = fs.readFileSync(file, ...args);
    if (typeof file === 'string') remember(file, activeReadRole, Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    return raw;
  } };
  const assistantPath = path.join(repository, 'src/assistant.ts'), assistantSource = fs.readFileSync(assistantPath, 'utf8');
  const actualFunctions = extractAssistantFunctions(assistantSource, ['resolveNestedConfigValues', 'resolveNestedTableData', 'resolveNestedListData',
    'resolveNestedDataFile', 'findAncestorDirectory', 'parseIniSections', 'mapInfoPathForFile', 'configuredMapCodesForFile']);
  const scope = { fs: readOnlyFs, path, ...text, ...tableReader, ...maps, isScriptCommentLine,
    nestedConfigCache: new Map(), nestedTableCache: new Map(), nestedListCache: new Map(), mapCodeCache: new Map(),
    vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: options.root } }] } },
    log: message => { if (resolverLogs.length < 200) resolverLogs.push(message); } };
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(actualFunctions, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText, scope);
  function resolve(kind, file, request) {
    const start = performance.now(), previous = activeReadRole;
    activeReadRole = `dependency:${kind}`;
    let result, error;
    try { result = scope[`resolveNested${kind}Data`] ? scope[`resolveNested${kind}Data`](file, request) : scope.resolveNestedConfigValues(file, request); }
    catch (caught) { error = String(caught); }
    finally { activeReadRole = previous; }
    resolverCalls.push({ kind, source: path.relative(options.root, file), path: String(request.path || '').slice(0, 200),
      outcome: error ? 'exception' : result ? result.complete ? 'complete' : 'partial' : 'unavailable',
      ms: Math.round((performance.now() - start) * 1000) / 1000, error });
    return result;
  }
  const sourceRecords = () => [...Object.keys(require.cache).filter(file => inside(file, path.join(repository, 'out'))),
    assistantPath, __filename, ...catalogFiles.map(file => path.join(repository, file))]
    .flatMap(file => {
      const source = file.endsWith('.js') && inside(file, path.join(repository, 'out'))
        ? path.join(repository, 'src', path.relative(path.join(repository, 'out'), file)).replace(/\.js$/, '.ts') : undefined;
      return [file, ...(source && fs.existsSync(source) ? [source] : [])];
    }).filter((file, index, all) => all.indexOf(file) === index).map(file => ({ file: path.relative(repository, file), sha256: hash(fs.readFileSync(file)) }));
  const sourceHashesBefore = sourceRecords();
  let snapshot;
  try {
    snapshot = await new VariableListScanner({ engine: () => engine,
      nestedOptions: file => { currentFile = file; return {
        resolveConfigValues: request => resolve('Config', file, request),
        resolveTableData: request => resolve('Table', file, request),
        resolveListData: request => resolve('List', file, request),
      }; },
      mapRanges: (source, file) => {
        const previous = activeReadRole; activeReadRole = 'mapInfo';
        try { return maps.findMapCodeRangesInText(source, file, scope.configuredMapCodesForFile(file), token => language.commandByName.get(token.toUpperCase())); }
        finally { activeReadRole = previous; }
      },
    }).scan([options.root]);
  } finally { nested.analyzeNestedVariables = originalAnalyze; }
  if (!snapshot) throw new Error('Production scan did not return a complete snapshot');
  const candidateIssues = [], sourceKinds = {}, perFileKinds = new Map();
  let totalOccurrences = 0;
  for (const [name, occurrences] of snapshot.occurrences) {
    totalOccurrences += occurrences.length;
    for (const occurrence of occurrences) {
      const kind = occurrence.source?.kind || 'direct'; sourceKinds[kind] = (sourceKinds[kind] || 0) + 1;
      const id = path.relative(options.root, occurrence.file), counts = perFileKinds.get(id) || {};
      counts[kind] = (counts[kind] || 0) + 1; perFileKinds.set(id, counts);
    }
    const variable = /^([UTAG])(\d+)$/.exec(name), flag = /^\[(\d+)\]$/.exec(name);
    if (variable && !snapshot.candidates.variables[variable[1]].has(Number(variable[2]))) candidateIssues.push({ type: 'used-variable-missing-from-candidate-exclusion', name });
    if (flag && !snapshot.candidates.personalFlags.has(Number(flag[1]))) candidateIssues.push({ type: 'used-flag-missing-from-candidate-exclusion', name });
  }
  for (const family of uncertainExpected) if (!snapshot.candidates.uncertainVariableFamilies.has(family)) candidateIssues.push({ type: 'missing-uncertain-family', family });
  if (flagsUncertainExpected && !snapshot.candidates.personalFlagsUncertain) candidateIssues.push({ type: 'missing-uncertain-personal-flags' });
  const familySummary = {};
  for (const family of candidates.candidateVariableFamilies()) {
    const unused = candidates.unusedVariableCandidates(family, snapshot.candidates);
    for (const value of unused) if (snapshot.candidates.variables[family].has(value)) candidateIssues.push({ type: 'used-slot-recommended-unused', name: family + value });
    familySummary[family] = { used: snapshot.candidates.variables[family].size, unusedCandidates: unused.length,
      uncertain: snapshot.candidates.uncertainVariableFamilies.has(family), limit: candidates.candidateVariableLimit(family, engine) };
  }
  const unusedFlags = candidates.unusedPersonalFlagCandidates(snapshot.candidates);
  for (const value of unusedFlags) if (snapshot.candidates.personalFlags.has(value)) candidateIssues.push({ type: 'used-flag-recommended-unused', name: `[${value}]` });
  const integrityFailures = [];
  for (const record of fileManifest.values()) {
    try { record.sha256After = hash(fs.readFileSync(record.file)); }
    catch (error) { record.readAfterError = String(error); }
    record.unchanged = !record.changesDuringReads && record.sha256After === record.sha256Before;
    if (!record.unchanged) integrityFailures.push(record.file);
    record.file = path.relative(options.root, record.file);
  }
  const sourceHashesAfter = sourceRecords(), afterSources = new Map(sourceHashesAfter.map(record => [record.file, record.sha256]));
  const changedSources = sourceHashesBefore.filter(record => afterSources.get(record.file) !== record.sha256);
  const freshness = sourceHashesBefore.filter(record => record.file.startsWith('out' + path.sep) && record.file.endsWith('.js')).map(record => {
    const output = path.join(repository, record.file), source = path.join(repository, 'src', record.file.slice(4)).replace(/\.js$/, '.ts');
    return { output: record.file, source: path.relative(repository, source), compiledNotOlderThanSource: !fs.existsSync(source) || fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs };
  });
  const totalStatus = field => {
    const total = { resolved: 0, partial: 0, unresolved: 0 };
    for (const item of analyses) for (const [status, count] of Object.entries(item[field])) total[status] += count;
    return total;
  };
  const gate = snapshot.errors.length === 0 && directoryErrors.length === 0 && integrityFailures.length === 0
    && candidateIssues.length === 0 && files.length === snapshot.scannedFiles && analyses.length === snapshot.scannedFiles
    && changedSources.length === 0 && freshness.every(record => record.compiledNotOlderThanSource);
  const report = { schema: 'boo.local-variable-analysis.v1', startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(), completedAt: new Date().toISOString(),
    root: options.root, engine: detection, passed: gate, readOnly: true, accuracyValidated: false,
    gateDefinition: { name: 'production-scan-candidate-consistency-and-byte-integrity',
      conditions: ['all enumerated saved scripts were analyzed', 'no scan/directory errors', 'known used slots excluded from unused candidates',
        'unresolved dynamic families carry uncertainty', 'all observed input bytes unchanged', 'loaded implementation unchanged and compilation not older than sources'],
      doesNotValidate: ['variable-statistics accuracy or recall', 'control-flow/data-flow semantic completeness', 'all runtime-possible slots are covered', 'native VS Code UI or game engine behavior'] },
    scope: { mode: 'saved-disk-files', scanRoots: scanRoots.map(file => path.relative(options.root, file)), filesEnumerated: files.length,
      scannedFiles: snapshot.scannedFiles, skippedLinks, directoryErrors, errors: snapshot.errors, encodings: group([...fileManifest.values()].filter(record => record.roles.includes('script')), record => record.encoding) },
    statistics: { uniqueEntries: snapshot.usages.size, sourceOccurrences: totalOccurrences, sourceKinds,
      nested: { occurrences: analyses.reduce((sum, item) => sum + item.nestedOccurrences, 0), status: totalStatus('nested'), samples: referenceSamples },
      personalFlags: { occurrences: analyses.reduce((sum, item) => sum + item.flagOccurrences, 0), status: totalStatus('personalFlags'), samples: flagSamples } },
    candidates: { families: familySummary, personalFlags: { used: snapshot.candidates.personalFlags.size, unusedCandidates: unusedFlags.length, uncertain: snapshot.candidates.personalFlagsUncertain }, consistencyIssues: candidateIssues },
    dependencies: { calls: resolverCalls.length, outcomes: group(resolverCalls, item => `${item.kind}:${item.outcome}`),
      uniqueRequests: new Set(resolverCalls.map(item => `${item.kind}:${item.source}:${item.path}`)).size,
      unavailableSamples: resolverCalls.filter(item => item.outcome !== 'complete').slice(0, 40), logs: resolverLogs,
      reads: [...fileManifest.values()].filter(record => record.roles.some(role => role.startsWith('dependency'))).length },
    performance: { totalMs: Math.round(performance.now() - started), nestedAnalysisMs: Math.round(analyses.reduce((sum, item) => sum + item.analysisMs, 0)), slowestFiles: [...analyses].sort((a, b) => b.analysisMs - a.analysisMs).slice(0, 20) },
    files: analyses.map(item => ({ ...item, sourceKinds: perFileKinds.get(item.file) || {} })),
    integrity: { checkedFiles: fileManifest.size, unchanged: integrityFailures.length === 0, failures: integrityFailures,
      dependencyBaseline: 'All scripts and MapInfo before scan; dynamically discovered dependencies at their first actual production-resolver read', manifest: [...fileManifest.values()] },
    implementation: { actualAssistantFunctions: actualFunctions.match(/function \w+/g), extractedFunctionsSha256: hash(actualFunctions), sourceHashesBefore, sourceHashesAfter,
      changedSources, freshness, node: process.version },
    limitations: ['Static source-reference distribution, not recall/precision and not server execution counts',
      'Read-only disk snapshot; no VS Code native UI or game client execution was exercised',
      'Uses standard per-engine production catalogs; no user-specific VS Code custom language settings',
      'Unknown callbacks, dynamic paths and data outside modeled semantics remain partial/unresolved; unused candidates are not proven safe-free slots'] };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, json, { flag: 'wx' });
    process.stdout.write(JSON.stringify({ output: options.output, passed: report.passed, engine, files: snapshot.scannedFiles,
      gateName: report.gateDefinition.name, accuracyValidated: false,
      nested: report.statistics.nested.status, personalFlags: report.statistics.personalFlags.status,
      sourceKinds, dependencyOutcomes: report.dependencies.outcomes, integrityFiles: report.integrity.checkedFiles,
      integrityUnchanged: report.integrity.unchanged, candidateIssues: candidateIssues.length, totalMs: report.performance.totalMs }, null, 2) + '\n');
  } else process.stdout.write(json);
  if (!gate) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
