const assert = require('node:assert/strict');
const { analyzeNestedVariables } = require('../out/utils/nested-variable-analysis');
const { collectCandidateUsage } = require('../out/utils/variable-candidates');

const failures = [];
let cases = 0;
function check(name, callback) {
  cases++;
  try { callback(); } catch (error) { failures.push(`${name}: ${error.message}`); }
}
function analyze(lines, engine = 'GOM') {
  return analyzeNestedVariables(lines.join('\n'), { engine });
}
function lastReference(result) {
  const reference = result.references.at(-1);
  assert.ok(reference, 'expected dynamic reference');
  return reference;
}

for (const engine of ['GOM', '996PC']) {
  check(`${engine} must not borrow GEE's two-argument MUL`, () => {
    const result = analyze(['MOV N1 20', 'MUL N1 2', 'EQUAL U<$STR(N1)> 0'], engine);
    assert.notEqual(lastReference(result).status, 'resolved');
  });
}
check('GEE has its own two-argument MUL evidence', () => {
  const result = analyze(['MOV N1 20', 'MUL N1 2', 'EQUAL U<$STR(N1)> 0'], 'GEE');
  assert.deepEqual(lastReference(result).variables, ['U40']);
  assert.equal(lastReference(result).status, 'resolved');
});
check('INC must not silently ignore an extra operand', () => {
  const result = analyze(['MOV N1 20', 'INC N1 1 10', 'EQUAL U<$STR(N1)> 0']);
  assert.notEqual(lastReference(result).status, 'resolved');
});
check('unsupported 996PC FORMULATION truncation flag still invalidates its destination', () => {
  const result = analyze(['MOV N1 20', 'FORMULATION 5/2 N1 1', 'EQUAL U<$STR(N1)> 0'], '996PC');
  const reference = lastReference(result);
  assert.ok(reference.variables.includes('U2') || reference.status !== 'resolved',
    'recognizing no result is not proof that N1 remains 20');
});

check('a may-write to two concrete targets cannot strong-update both', () => {
  const result = analyze([
    'MOV N$slot1 21', 'MOV N$slot2 22', 'MOV N$idx 1',
    '#IF', 'CHECKLEVEL 1', '#ACT', 'MOV N$idx 2',
    '#IF', 'CHECKLEVEL 1', '#ACT',
    'MOV N$slot<$STR(N$idx)> 99', 'EQUAL U<$STR(N$slot1)> 0',
  ]);
  assert.ok(lastReference(result).variables.includes('U21'), 'branch choosing slot2 must preserve slot1=21');
  assert.ok(lastReference(result).variables.includes('U99'), 'branch choosing slot1 writes slot1=99');
});

for (const randomArgument of ['<$STR(N$unknown)>', '99999']) {
  check(`unknown/over-limit MOVR invalidates old value (${randomArgument})`, () => {
    const result = analyze([
      'MOV N$idx 20', `MOVR N$idx ${randomArgument}`, 'EQUAL U<$STR(N$idx)> 0',
    ]);
    assert.notEqual(lastReference(result).status, 'resolved');
  });
}
check('inline ACT external call cannot preserve a precise old value', () => {
  const result = analyze([
    'MOV N$idx 20', '#ACT #CALL [foo.txt] @change', 'EQUAL U<$STR(N$idx)> 0',
  ]);
  assert.notEqual(lastReference(result).status, 'resolved');
});
check('condition commands with output parameters invalidate old numeric values', () => {
  const result = analyze([
    'MOV N$idx 20', '#IF', 'FINDMONPOINT 0 monster N$idx N$y',
    '#ACT', 'EQUAL U<$STR(N$idx)> 0',
  ]);
  assert.notEqual(lastReference(result).status, 'resolved', 'FINDMONPOINT writes coordinates in IF context');
});
check('output command examples in SAY are not executable writes', () => {
  const result = analyze([
    'MOV N$idx 20', '#SAY', 'FINDMONPOINT 0 monster N$idx N$y',
    '#ACT', 'EQUAL U<$STR(N$idx)> 0',
  ]);
  assert.deepEqual(lastReference(result).variables, ['U20']);
  assert.equal(lastReference(result).status, 'resolved');
});
check('dynamic arithmetic targets must update or invalidate the matching family', () => {
  const result = analyze([
    'MOV N$idx 1', 'MOV N$slot1 20', 'INC N$slot<$STR(N$idx)> 10',
    'EQUAL U<$STR(N$slot1)> 0',
  ]);
  const reference = lastReference(result);
  assert.ok(reference.variables.includes('U30') || reference.status !== 'resolved',
    'unmodeled dynamic INC must not leave stale U20 resolved');
});
check('GOTO reachability cannot hide an independent UI entry into the same label', () => {
  const result = analyze([
    '[@main]', 'MOV N$idx 20', 'GOTO @dest',
    '[@menu]', '#SAY', '<go/@dest>',
    '[@dest]', 'EQUAL U<$STR(N$idx)> 0',
  ]);
  assert.notEqual(lastReference(result).status, 'resolved', 'UI entry does not inherit main\'s idx=20');
});
check('Cartesian product truncation must reach personal-flag candidate uncertainty', () => {
  const script = [
    ...Array.from({ length: 32 }, (_, index) => `<go/@entry(${index},${index})>`),
    '[@entry]',
    'FORMULATION <$SCRIPTPARAM1>*32+<$SCRIPTPARAM2>+1 N$idx',
    'CHECK [<$STR(N$idx)>] 0',
  ];
  const result = analyze(script);
  const flag = result.personalFlags[0];
  // If calls remain correlated, all 32 actual pairs can resolve precisely. If
  // parameters are cross-product may-sets, the 1024 combinations exceed the cap
  // and must remain incomplete. Neither strategy may assert a complete set that
  // omits the real i=16 call's flag529.
  assert.ok(flag.flags.includes('[529]') || flag.status !== 'resolved');
  if (!flag.flags.includes('[529]')) {
    const usage = collectCandidateUsage(script.join('\n'), { engine: 'GOM', nestedAnalysis: result });
    assert.equal(usage.personalFlagsUncertain, true);
  }
});
check('an unbounded back edge terminates with an incomplete may-set', () => {
  const result = analyze([
    '[@main]', 'MOV N$idx 20', 'GOTO @loop',
    '[@loop]', 'INC N$idx 10',
    '#IF', 'CHECKLEVEL 1', '#ACT', 'GOTO @loop',
    '#ELSEACT', 'EQUAL U<$STR(N$idx)> 0',
  ]);
  assert.notEqual(lastReference(result).status, 'resolved');
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  throw new Error(`Source-flow safety: ${failures.length}/${cases} checks failed`);
}
console.log(`Source-flow safety tests passed (${cases} checks)`);
