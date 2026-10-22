const assert = require('node:assert/strict');
const { analyzeNestedVariables, resolveScriptValueExpressions } = require('../out/utils/nested-variable-analysis');
const { analyzeVariableListFile } = require('../out/utils/variable-list');
const { collectCandidateUsage, unusedVariableCandidates, unusedPersonalFlagCandidates } = require('../out/utils/variable-candidates');

function analyze(lines, options = {}) {
  return analyzeNestedVariables(lines.join('\n'), { engine: 'GOM', ...options });
}
function reference(result, raw, occurrence = 0) {
  const found = result.references.filter(item => item.raw === raw)[occurrence];
  assert.ok(found, `missing ${raw}`);
  return found;
}
const slot = 'U<$STR(N$新变量)>';
const original = ['MOV N$原变量 20', 'MOV N$新变量 <$STR(N$原变量)>', 'INC N$新变量 10', `EQUAL ${slot} 0`];
let result = analyze(original);
assert.deepEqual(reference(result, slot).variables, ['U30'], '20 + 10 must propagate into U30, not stale U20');
assert.equal(reference(result, slot).status, 'resolved');
assert.ok(reference(result, slot).trace.some(step => step.line === 2 && /INC/.test(step.description)));
const aggregate = analyzeVariableListFile(original.join('\n'), 'C:/audit/Envir/Market_Def/test.txt', { engine: () => 'GOM' });
assert.ok(aggregate.variables.some(item => item.name === 'U30'));
assert.ok(!aggregate.variables.some(item => item.name === 'U20'));
const usage = collectCandidateUsage(original.join('\n'), { engine: 'GOM' });
assert.ok(!unusedVariableCandidates('U', usage).includes(30));
assert.deepEqual(resolveScriptValueExpressions(original.join('\n'), [
  { expression: 'N$新变量', line: 2 }, { expression: 'N$新变量', line: 3 },
], { engine: 'GOM' }).map(item => item.values), [['20'], ['30']]);

result = analyze(['MOV N$新变量 20', `EQUAL ${slot} 0`, 'INC N$新变量 10', `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot, 0).variables, ['U20']);
assert.deepEqual(reference(result, slot, 1).variables, ['U30']);
result = analyze(['MOV N$新变量 20', 'MOV N$新变量 30', `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot).variables, ['U30'], 'strong assignment kills the old value');
result = analyze(['#ACT MOV N$新变量 20', '#ACT INC N$新变量 10', `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot).variables, ['U30']);
result = analyze(['MOV N1 20', 'INC N1 10', 'MOV N$新变量 <$STR(N1)>', `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot).variables, ['U30']);

result = analyze(['[@main]', '#SAY', '<计算/@计算(20)>', '[@计算]', '#ACT', 'MOV N$新变量 <$SCRIPTPARAM1>', 'INC N$新变量 10', `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot).variables, ['U30']);
assert.equal(reference(result, slot).status, 'resolved');
result = analyze(['[@main]', '#ACT', 'MOV N$原变量 20', '#SAY', '<计算/@计算(<$STR(N$原变量)>)>', '#ACT', 'INC N$原变量 100', '[@计算]', '#ACT', 'MOV N$新变量 <$SCRIPTPARAM1>', 'INC N$新变量 10', `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot).variables, ['U30'], 'parameters read the SAY position, not the caller final value');

for (const formula of ['(<$STR(N$原变量)>+10)', '<$STR(N$原变量)>+5+5', '(<$STR(N$原变量)>+10)*2/2']) {
  result = analyze(['MOV N$原变量 20', `FORMULATION ${formula} N$新变量`, `EQUAL ${slot} 0`]);
  assert.deepEqual(reference(result, slot).variables, ['U30']);
}
result = analyze(['MOV N$idx 1', 'MOV N$slot1 21', 'EQUAL U<$STR(N$slot<$STR(N$idx)>)> 0']);
assert.deepEqual(reference(result, 'U<$STR(N$slot<$STR(N$idx)>)>').variables, ['U21']);
result = analyze(['MOV N$idx 1', 'MOV N$flag1 203', 'CHECK [<$STR(N$flag<$STR(N$idx)>)>] 0']);
assert.deepEqual(result.personalFlags[0].flags, ['[203]']);

result = analyze(['[@a]', 'MOV N$新变量 20', `EQUAL ${slot} 0`, '[@b]', 'MOV N$新变量 80', `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot, 0).variables, ['U20']);
assert.deepEqual(reference(result, slot, 1).variables, ['U80']);
result = analyze(['#IF', 'CHECKLEVEL 1', '#ACT', 'MOV N$新变量 20', '#ELSEACT', 'MOV N$新变量 40', '#IF', 'CHECKLEVEL 1', '#ACT', 'INC N$新变量 10', `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot).variables, ['U30', 'U50'], 'alternative branches must not execute consecutively');
result = analyze(['MOV N$新变量 20', '#SAY', 'MOV N$新变量 30', '#ACT', `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot).variables, ['U20'], 'SAY text is not an assignment');
result = analyze([`EQUAL ${slot} 0`, 'MOV N$新变量 30']);
assert.equal(reference(result, slot).status, 'unresolved', 'future assignments cannot make earlier reads precise');
result = analyze(['MOV N$新变量 21', 'READCONFIGFILEITEM missing.ini section key N$新变量', `EQUAL ${slot} 0`], { resolveConfigValues: () => undefined });
assert.notEqual(reference(result, slot).status, 'resolved', 'missing dependency cannot preserve a precise old value');
result = analyze(['MOV N$slot1 21', 'MOV N$slot<$STR(N$unknown)> <$USERNAME>', 'EQUAL U<$STR(N$slot1)> 0']);
assert.notEqual(reference(result, 'U<$STR(N$slot1)>').status, 'resolved', 'unknown dynamic writes invalidate possibly overwritten values');

const sequential = Array.from({ length: 513 }, (_, index) => `MOV N$新变量 ${index + 1}`);
result = analyze([...sequential, `EQUAL ${slot} 0`]);
assert.deepEqual(reference(result, slot).variables, ['U513'], '513 overwrites are not 513 alternatives');
const callers = Array.from({ length: 513 }, (_, index) => `<按钮/@大量参数(${index + 1})>`);
const flagText = [...callers, '[@大量参数]', 'CHECK [<$SCRIPTPARAM1>] 0'].join('\n');
const manyFlags = analyzeNestedVariables(flagText, { engine: 'GOM' });
assert.notEqual(manyFlags.personalFlags[0].status, 'resolved');
const manyUsage = collectCandidateUsage(flagText, { engine: 'GOM', nestedAnalysis: manyFlags });
assert.equal(manyUsage.personalFlagsUncertain, true, 'bounded alternatives must retain uncertainty');
assert.ok(!unusedPersonalFlagCandidates(manyUsage).includes(1));
result = analyze(['MOV N$新变量 20', 'SUM N1 N2', `EQUAL ${slot} 0`], { engine: 'GEE' });
assert.notEqual(reference(result, slot).status, 'resolved', 'unmodeled implicit SUM cannot preserve a precise old value');
result = analyze(['MOV N$新变量 20', 'MOV <$CSTR(N$新变量)> 30', `EQUAL ${slot} 0`]);
assert.notEqual(reference(result, slot).status, 'resolved', 'unknown owner writes cannot prove current-owner constants');
const tableOptions = { resolveTableData: () => ({ rows: [['21'], ['22']], complete: true }) };
result = analyze(['MOV N$row 1', 'READEXCEL table.xls <$STR(N$row)>', 'INC N$row 1',
  'MOV N$新变量 <$GLOBAL(Excel0)>', `EQUAL ${slot} 0`], tableOptions);
assert.deepEqual(reference(result, slot).variables, ['U21'], 'Excel columns snapshot the row at READEXCEL, not the later row value');
result = analyze(['MOV N$新变量 <$GLOBAL(Excel0)>', `EQUAL ${slot} 0`, 'READEXCEL table.xls 1'], tableOptions);
assert.equal(reference(result, slot).status, 'unresolved', 'a future READEXCEL cannot initialize earlier reads');
result = analyze(['MOV N$新变量 <$table(0,0)>', `EQUAL ${slot} 0`, 'CSVOPENCACHE table.csv'], tableOptions);
assert.equal(reference(result, slot).status, 'unresolved', 'a future CSV cache load cannot initialize earlier reads');
result = analyze(['CSVOPENCACHE table.csv', 'MOV N$新变量 <$table(0,0)>', `EQUAL ${slot} 0`], tableOptions);
assert.deepEqual(reference(result, slot).variables, ['U21']);
assert.equal(reference(result, slot).status, 'resolved');

// Independent bounded integer oracle. Expected values are computed while
// constructing scripts, never by calling the production expression evaluator.
let randomState = 0x4340;
const next = maximum => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % maximum; };
let oracleCases = 0;
for (const engine of ['GOM', 'GEE', '996PC']) for (let sample = 0; sample < 60; sample++) {
  let value = next(30);
  const script = [`MOV N$oracle ${value}`];
  const expected = [];
  for (let step = 0; step < 10; step++) {
    script.push('EQUAL U<$STR(N$oracle)> 0');
    expected.push(`U${value}`);
    const operand = next(6);
    switch (next(5)) {
      case 0: script.push(`INC N$oracle ${operand}`); value += operand; break;
      case 1: script.push(`DEC N$oracle ${Math.min(value, operand)}`); value -= Math.min(value, operand); break;
      case 2: script.push(`MUL N$oracle N$oracle ${operand % 2 + 1}`); value *= operand % 2 + 1; break;
      case 3: script.push(`FORMULATION (<$STR(N$oracle)>+${operand})*1 N$oracle`); value += operand; break;
      default: value = next(30); script.push(`MOV N$oracle ${value}`); break;
    }
  }
  script.push('EQUAL U<$STR(N$oracle)> 0'); expected.push(`U${value}`);
  const output = analyze(script, { engine }).references;
  assert.deepEqual(output.map(item => item.variables), expected.map(name => [name]), `${engine} integer oracle sample ${sample}`);
  assert.ok(output.every(item => item.status === 'resolved'));
  oracleCases++;
}
console.log(`variable-source-flow.test.js: PASS (${oracleCases} independent integer oracle scripts; source order, NPC snapshots, branches, nested slots and candidate safety)`);
