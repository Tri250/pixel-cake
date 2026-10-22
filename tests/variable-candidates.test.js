const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function main() {
  const {
    collectCandidateUsage,
    createCandidateUsage,
    mergeCandidateUsage,
    unusedPersonalFlagCandidates,
    unusedVariableCandidates,
  } = require('../out/utils/variable-candidates');

  const direct = collectCandidateUsage([
    'mov u3 1',
    'inc T499 1',
    'equal A470 0',
    'mov G499 1',
    '; mov U4 1',
    '// set [9] 1',
    'set [1,3-4] 1',
    'reset [10] 3',
  ].join('\n'));
  assert.deepEqual([...direct.variables.U], [3]);
  assert.deepEqual([...direct.variables.T], [499]);
  assert.deepEqual([...direct.variables.A], [470]);
  assert.deepEqual([...direct.variables.G], [499]);
  assert.deepEqual([...direct.personalFlags].sort((a, b) => a - b), [1, 3, 4, 10, 11, 12]);
  assert.equal(unusedVariableCandidates('U', direct).includes(3), false);
  assert.equal(unusedVariableCandidates('U', direct).includes(4), true);
  assert.equal(unusedPersonalFlagCandidates(direct).includes(10), false);
  assert.equal(unusedPersonalFlagCandidates(direct).includes(9), true);
  assert.equal(unusedVariableCandidates('A', direct).at(-1), 999);
  assert.equal(unusedVariableCandidates('G', direct).includes(499), false);

  const nested = collectCandidateUsage([
    'mov N$编号 151',
    'mov U<$STR(N$编号)> 1',
    'set [<$STR(N$编号)>] 1',
  ].join('\n'));
  assert.equal(nested.variables.U.has(151), true);
  assert.equal(nested.personalFlags.has(151), true);

  const unresolved = collectCandidateUsage([
    'mov U3 1',
    'mov U<$STR(N$运行时下标)> 1',
    'set [3] 1',
    'set [<$STR(N$运行时标识)>] 1',
  ].join('\n'));
  assert.equal(unresolved.uncertainVariableFamilies.has('U'), true);
  assert.equal(unresolved.personalFlagsUncertain, true);
  const unresolvedUCandidates = unusedVariableCandidates('U', unresolved);
  assert.deepEqual(unresolvedUCandidates.slice(0, 5), [0, 1, 2, 4, 5]);
  assert.equal(unresolvedUCandidates.includes(3), false);
  assert.equal(unresolvedUCandidates.at(-1), 499);
  const unresolvedFlagCandidates = unusedPersonalFlagCandidates(unresolved);
  assert.deepEqual(unresolvedFlagCandidates.slice(0, 5), [1, 2, 4, 5, 6]);
  assert.equal(unresolvedFlagCandidates.includes(3), false);
  assert.equal(unresolvedFlagCandidates.at(-1), 1024);
  assert.equal(unusedVariableCandidates('T', unresolved).includes(0), true);

  const crlfText = '; mov U1 1\r\nMAP U2\r\nmov U3 1';
  const excludedStart = crlfText.indexOf('U2');
  const crlf = collectCandidateUsage(crlfText, {
    excludedRanges: [{ start: excludedStart, end: excludedStart + 2 }],
  });
  assert.deepEqual([...crlf.variables.U], [3]);

  for (const engine of ['GOM', 'GEE', '996PC']) {
    const scopedNames = collectCandidateUsage([
      '#ACT',
      'VAR INTEGER HUMAN U3',
      'CALCVAR HUMAN U3 + 5',
      'LOADVAR HUMAN U3 vars.txt',
      'SAVEVAR HUMAN U3 vars.txt',
      '#SAY',
      '<$HUMAN(U3)>',
    ].join('\r\n'), { engine });
    assert.equal(scopedNames.variables.U.has(3), false, `${engine}: a scoped name U3 is not an ordinary U3 slot`);
    assert.equal(unusedVariableCandidates('U', scopedNames).includes(3), true);
    assert.equal(scopedNames.uncertainVariableFamilies.size, 0, 'literal scoped names are not dynamic slot references');
  }
  const mixedScopes = collectCandidateUsage([
    '#ACT VAR INTEGER HUMAN U3',
    '#ELSEACT CALCVAR GUILD T4 + 5',
    '#SAY',
    '<$HUMAN(U3)> <$GUILD(T4)> <$U3>',
    'VAR INTEGER HUMAN U7',
    '#ACT',
    'VAR INTEGER HUMAN <$STR(U9)>',
    'CLEARVAR S0 5',
  ].join('\n'), { engine: 'GEE' });
  assert.deepEqual([...mixedScopes.variables.U], [3, 7, 9], 'real adjacent placeholders and dynamic-name inputs remain ordinary references; SAY examples are not commands');
  assert.equal(mixedScopes.variables.T.has(4), false);
  const { analyzeVariableListFile } = require('../out/utils/variable-list');
  const shared = analyzeVariableListFile('#ACT\rVAR INTEGER HUMAN U3\r#SAY\r<$HUMAN(U3)> <$U4>', 'scope.txt', { engine: () => 'GOM' });
  assert.equal(shared.variables.some(item => item.name === 'U3'), false);
  assert.equal(shared.candidates.variables.U.has(3), false, 'list and candidates share semantic exclusions');
  assert.equal(shared.candidates.variables.U.has(4), true);

  const merged = mergeCandidateUsage(createCandidateUsage(), direct);
  mergeCandidateUsage(merged, nested);
  assert.equal(merged.variables.U.has(3), true);
  assert.equal(merged.variables.U.has(151), true);
  assert.equal(merged.personalFlags.has(151), true);

  const assistant = fs.readFileSync(path.join(__dirname, '..', 'src', 'assistant.ts'), 'utf8');
  assert.match(assistant, /CompletionItem\('候选变量'/);
  assert.match(assistant, /CompletionItem\('候选标识'/);
  assert.match(assistant, /command: 'boo\.pickUnusedScriptCandidate'/);
  assert.doesNotMatch(assistant, /无法静态确定编号的 \$\{family\} 类动态变量/);
  assert.doesNotMatch(assistant, /动态个人标识，暂不提供候选/);
  assert.match(assistant, /usage\.personalFlagsUncertain/);
  assert.match(assistant, /这些候选不能保证未使用/);
  assert.match(assistant, /snapshot\.errors\.length/);
  assert.match(assistant, /选择当前统计中未使用的个人标识/);
  assert.match(assistant, /candidateUsageGeneration/);

  console.log('variable-candidates.test.js: PASS');
}

main();
