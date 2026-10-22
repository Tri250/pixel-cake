const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTemporaryDirectory } = require('./helpers/temp-cleanup');
const { buildLanguageIndex } = require('../out/utils/command-index');
const { collectConfiguredMapCodes, findMapCodeRangesInLine, findMapCodeRangesInText } = require('../out/utils/map-code-context');
const { analyzeVariableListFile, VariableListScanner } = require('../out/utils/variable-list');
const { unusedVariableCandidates } = require('../out/utils/variable-candidates');

const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const commands = read('data/commands.json');
const variables = read('data/variables.json');
const catalogs = { GOM: read('data/functions.json'), GEE: read('data/functions-gee.json'), '996PC': read('data/functions-996pc.json') };
const mapCodes = collectConfiguredMapCodes('[U3 测试地图]\n[U003 前导零地图]\n[N3 下标地图]');

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'boo-map-variable-filter-'));
  const directory = path.join(temporary, 'Envir', 'Market_Def');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'maps.txt');
  try {
    for (const engine of ['GOM', 'GEE']) {
      const language = buildLanguageIndex(commands, variables, catalogs, engine);
      const resolve = token => language.commandByName.get(token.toUpperCase());
      assert.equal(resolve('MAPMOVE').completionVerified, true, `${engine} own verified map syntax`);
      const options = {
        engine: () => engine,
        mapRanges: (text, source) => findMapCodeRangesInText(text, source, mapCodes, resolve),
      };
      for (const text of [
        'MAPMOVE <$STR(U3)> 100 100',
        'MAPMOVE <$U3> 100 100',
        'MAPMOVE <$STR(N$地图<$STR(N3)>)> 100 100',
        'MAPMOVE <$STR( U3 )> 100 100',
        'MAPMOVE <$STR(U003)> 100 100',
        'MAPMOVE <$STR(U3) 100 100',
      ]) {
        assert.deepEqual(findMapCodeRangesInLine(text, file, mapCodes, resolve), [], `${engine} expression must not be a literal map: ${text}`);
        const result = analyzeVariableListFile(text, file, options);
        const expected = text.includes('N3') ? 'N3' : 'U3';
        assert.ok(result.variables.some(variable => variable.name === expected), `${engine} ${expected} retained in list: ${text}`);
        if (expected === 'U3') {
          assert.equal(result.candidates.variables.U.has(3), true, `${engine} U3 used in expression`);
          assert.equal(unusedVariableCandidates('U', result.candidates).includes(3), false, `${engine} used U3 cannot be an unused candidate`);
        }
      }
      for (const code of ['U3', 'U003', 'u3']) {
        const text = `MAPMOVE ${code} 100 100`;
        assert.deepEqual(findMapCodeRangesInLine(text, file, mapCodes, resolve).map(range => range.text), [code]);
        const result = analyzeVariableListFile(text, file, options);
        assert.equal(result.variables.some(variable => variable.name === 'U3'), false, `${engine} literal map is not a variable`);
        assert.equal(result.candidates.variables.U.has(3), false, `${engine} literal map is not occupied U3`);
      }
      for (const text of ['MOV U3 1', 'MAPMOVE U999 100 100', 'MAPMOVE 0 U3 100', 'GETMAPROUTEINFO 1 0 U3 N3 N4']) {
        assert.deepEqual(findMapCodeRangesInLine(text, file, mapCodes, resolve), [], `${engine} not a configured literal map: ${text}`);
        const expected = text.includes('U999') ? 'U999' : 'U3';
        const result = analyzeVariableListFile(text, file, options);
        assert.ok(result.variables.some(variable => variable.name === expected), `${engine} ${expected} remains a variable: ${text}`);
        assert.equal(result.candidates.variables.U.has(Number(expected.slice(1))), true);
      }
      assert.deepEqual(findMapCodeRangesInLine('MAPMOVE U3-<$STR(N3)> 100 100', file, mapCodes, resolve), [], `${engine} a dynamic map construction has no proven literal map span`);
      const text = ['MAPMOVE U3 100 100', 'MAPMOVE <$STR(U3)> 100 100', 'MAPMOVE <$U003> 100 100', 'MOV N3 1', 'MAPMOVE <$STR(N$地图<$STR(N3)>)> 100 100'].join('\r\n');
      fs.writeFileSync(file, text, 'utf8');
      const snapshot = await new VariableListScanner(options).scan([temporary]);
      assert.equal(snapshot.errors.length, 0);
      assert.equal(snapshot.scannedFiles, 1);
      assert.equal(snapshot.usages.get('U3')?.count, 2, `${engine} scanner counts only the two real U3 references`);
      assert.deepEqual(snapshot.occurrences.get('U3').map(item => item.line), [1, 2]);
      assert.equal(snapshot.usages.get('N3')?.count, 2, `${engine} nested expression keeps real index variable`);
      assert.equal(unusedVariableCandidates('U', snapshot.candidates).includes(3), false);
      assert.equal(snapshot.candidates.uncertainVariableFamilies.size, 0);
    }
    const unverified = () => ({ params: ['地图'], completionVerified: false });
    assert.deepEqual(findMapCodeRangesInLine('MAPMOVE U3', file, mapCodes, unverified), [], 'unverified syntax cannot hide variable-like map tokens');
    console.log('map-variable-filter.test.js: PASS (GOM/GEE verified catalogs; expressions, literals, list counts, locations and unused candidates)');
  } finally { removeTemporaryDirectory(temporary); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
