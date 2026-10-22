const assert = require('node:assert/strict');
const { analyzeNestedVariables } = require('../out/utils/nested-variable-analysis');
const { analyzeVariableListFile } = require('../out/utils/variable-list');
const {
  collectCandidateUsage, unusedVariableCandidates, unusedPersonalFlagCandidates,
} = require('../out/utils/variable-candidates');

// These fixtures enumerate small, manually provable paths. Expected values are
// literal oracles, not the result of copying the production CFG or evaluator.
const slot = 'U<$STR(N$编号)>';
const flag = '[<$STR(N$编号)>]';
const condition = ['#IF', 'CHECKLEVELEX > 1'];
const joinedRead = ['#IF', `EQUAL ${slot} 0`];
const fixtures = [
  {
    name: 'reverse failure BREAK must not leave stale U20 marked complete or recommend U30',
    lines: ['#ACT', 'MOV N$编号 20', ...condition, '#ELSEACT', 'BREAK',
      '#ACT', 'INC N$编号 10', ...joinedRead],
    refs: [[30]], complete: true,
  },
  {
    name: 'forward ACT and ELSEACT strongly replace the old value',
    lines: ['MOV N$编号 10', ...condition, '#ACT', 'MOV N$编号 20',
      '#ELSEACT', 'MOV N$编号 40', ...joinedRead],
    refs: [[20, 40]], complete: true,
  },
  {
    name: 'reverse ELSEACT and ACT strongly replace the old value',
    lines: ['MOV N$编号 10', ...condition, '#ELSEACT', 'MOV N$编号 40',
      '#ACT', 'MOV N$编号 20', ...joinedRead],
    refs: [[20, 40]], complete: true,
  },
  {
    name: 'forward alternative arithmetic is mutually exclusive, not sequential',
    lines: ['MOV N$编号 20', ...condition, '#ACT', 'INC N$编号 10',
      '#ELSEACT', 'INC N$编号 20', ...joinedRead],
    refs: [[30, 40]], complete: true,
  },
  {
    name: 'reverse alternative arithmetic is mutually exclusive, not sequential',
    lines: ['MOV N$编号 20', ...condition, '#ELSEACT', 'INC N$编号 20',
      '#ACT', 'INC N$编号 10', ...joinedRead],
    refs: [[30, 40]], complete: true,
  },
  {
    name: 'forward ACT plus SAY share the true branch; ELSEACT plus ELSESAY share false',
    lines: ['MOV N$编号 10', ...condition, '#ACT', 'MOV N$编号 20',
      '#SAY', `真支 ${slot}`, '#ELSEACT', 'MOV N$编号 40',
      '#ELSESAY', `假支 ${slot}`, ...joinedRead],
    refs: [[20], [40], [20, 40]], complete: true,
  },
  {
    name: 'reverse ELSEACT plus ELSESAY do not steal later ACT plus SAY',
    lines: ['MOV N$编号 10', ...condition, '#ELSEACT', 'MOV N$编号 40',
      '#ELSESAY', `假支 ${slot}`, '#ACT', 'MOV N$编号 20',
      '#SAY', `真支 ${slot}`, ...joinedRead],
    refs: [[40], [20], [20, 40]], complete: true,
  },
  {
    name: 'multiple forward blocks with the same polarity all execute on that branch',
    lines: ['MOV N$编号 10', ...condition, '#ACT', 'MOV N$编号 20',
      '#SAY', `真支第一次 ${slot}`, '#ACT', 'INC N$编号 1', '#SAY', `真支第二次 ${slot}`,
      '#ELSEACT', 'MOV N$编号 40', '#ELSESAY', `假支第一次 ${slot}`,
      '#ELSEACT', 'INC N$编号 2', '#ELSESAY', `假支第二次 ${slot}`, ...joinedRead],
    refs: [[20], [21], [40], [42], [21, 42]], complete: true,
  },
  {
    name: 'multiple reverse blocks with the same polarity stay on their own branch',
    lines: ['MOV N$编号 10', ...condition, '#ELSEACT', 'MOV N$编号 40',
      '#ELSESAY', `假支第一次 ${slot}`, '#ELSEACT', 'INC N$编号 2', '#ELSESAY', `假支第二次 ${slot}`,
      '#ACT', 'MOV N$编号 20', '#SAY', `真支第一次 ${slot}`,
      '#ACT', 'INC N$编号 1', '#SAY', `真支第二次 ${slot}`, ...joinedRead],
    refs: [[40], [42], [20], [21], [21, 42]], complete: true,
  },
  {
    name: 'missing false action skips directly to the next IF with the old value',
    lines: ['MOV N$编号 10', ...condition, '#ACT', 'MOV N$编号 20', ...joinedRead],
    refs: [[10, 20]], complete: true,
  },
  {
    name: 'missing true action skips a false-only block to the next IF',
    lines: ['MOV N$编号 10', ...condition, '#ELSEACT', 'MOV N$编号 40', ...joinedRead],
    refs: [[10, 40]], complete: true,
  },
  {
    name: 'SAY-only branch does not execute display text as MOV',
    lines: ['MOV N$编号 10', ...condition, '#SAY', 'MOV N$编号 99', ...joinedRead],
    refs: [[10]], complete: true,
  },
  {
    name: 'ELSESAY-only branch does not execute display text as MOV',
    lines: ['MOV N$编号 10', ...condition, '#ELSESAY', 'MOV N$编号 99', ...joinedRead],
    refs: [[10]], complete: true,
  },
  {
    name: 'forward true BREAK does not terminate or run the false branch',
    lines: ['MOV N$编号 10', ...condition, '#ACT', 'MOV N$编号 20', 'BREAK',
      'MOV N$编号 99', '#ELSEACT', 'MOV N$编号 40', ...joinedRead],
    refs: [[40]], complete: true,
  },
  {
    name: 'reverse false BREAK does not terminate or run the true branch',
    lines: ['MOV N$编号 10', ...condition, '#ELSEACT', 'MOV N$编号 40', 'BREAK',
      'MOV N$编号 99', '#ACT', 'MOV N$编号 20', ...joinedRead],
    refs: [[20]], complete: true,
  },
  {
    name: 'forward GOTO keeps true 20 separate from false 40 plus 1',
    lines: ['[@main]', 'MOV N$编号 10', ...condition, '#ACT', 'MOV N$编号 20', 'GOTO @done',
      '#ELSEACT', 'MOV N$编号 40', 'INC N$编号 1', 'GOTO @done',
      '[@done]', '#ACT', `EQUAL ${slot} 0`],
    refs: [[20, 41]], complete: true,
  },
  {
    name: 'reverse GOTO keeps false 40 separate from true 20 plus 1',
    lines: ['[@main]', 'MOV N$编号 10', ...condition, '#ELSEACT', 'MOV N$编号 40', 'GOTO @done',
      '#ACT', 'MOV N$编号 20', 'INC N$编号 1', 'GOTO @done',
      '[@done]', '#ACT', `EQUAL ${slot} 0`],
    refs: [[21, 40]], complete: true,
  },
  {
    name: 'inline ACT and ELSEACT retain branch identity',
    lines: ['MOV N$编号 10', ...condition, '#ACT MOV N$编号 20',
      '#ELSEACT MOV N$编号 40', ...joinedRead],
    refs: [[20, 40]], complete: true,
  },
  {
    name: 'inline reverse ELSEACT and ACT retain branch identity',
    lines: ['MOV N$编号 10', ...condition, '#ELSEACT MOV N$编号 40',
      '#ACT MOV N$编号 20', ...joinedRead],
    refs: [[20, 40]], complete: true,
  },
  {
    name: 'NPC parameters survive a reversed failed-item BREAK into U and personal flag',
    lines: ['[@main]', '#SAY', '<入口一/@calculate(20)>', '<入口二/@calculate(40)>',
      '[@calculate]', '#ACT', 'MOV N$编号 <$SCRIPTPARAM1>', '#IF', 'CHECKITEM 灵符 1',
      '#ELSEACT', 'MESSAGEBOX 缺少材料', 'BREAK', '#ACT', 'INC N$编号 10',
      `EQUAL ${slot} 0`, `SET ${flag} 1`],
    refs: [[30, 50]], flags: [[30, 50]], complete: true,
  },
];

const sorted = values => [...values].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
let checks = 0;
const equal = (actual, expected, message) => { checks++; assert.deepEqual(actual, expected, message); };
const failures = [];
let cases = 0;

for (const engine of ['GOM', 'GEE', '996PC']) for (const fixture of fixtures) {
  cases++;
  const name = `${engine}: ${fixture.name}`;
  try {
    const text = fixture.lines.join('\n');
    const result = analyzeNestedVariables(text, { engine });
    const expectedRefs = fixture.refs.map(numbers => sorted(numbers.map(number => `U${number}`)));
    const expectedFlags = (fixture.flags || []).map(numbers => sorted(numbers.map(number => `[${number}]`)));
    equal(result.references.map(reference => sorted(reference.variables)), expectedRefs, `${name}: point-specific U references`);
    equal(result.personalFlags.map(reference => sorted(reference.flags)), expectedFlags, `${name}: point-specific personal flags`);
    if (fixture.complete) {
      equal(result.references.map(reference => reference.status), expectedRefs.map(() => 'resolved'), `${name}: completeness must not hide an omitted branch`);
      equal(result.personalFlags.map(reference => reference.status), expectedFlags.map(() => 'resolved'), `${name}: flag completeness`);
    }

    const aggregate = analyzeVariableListFile(text, `C:/audit/Envir/Market_Def/${engine}-branches.txt`, { engine: () => engine });
    for (let index = 0; index < result.references.length; index++) {
      const reference = result.references[index];
      equal(sorted(aggregate.variables.filter(item => item.line === reference.line && /^U\d+$/.test(item.name)).map(item => item.name)),
        expectedRefs[index], `${name}: the final list must attribute every derived U to its real source line`);
    }
    for (let index = 0; index < result.personalFlags.length; index++) {
      const reference = result.personalFlags[index];
      equal(sorted(aggregate.variables.filter(item => item.line === reference.line && /^\[\d+\]$/.test(item.name)).map(item => item.name)),
        expectedFlags[index], `${name}: the final list must attribute every derived flag to its real source line`);
    }

    const usage = collectCandidateUsage(text, { engine, nestedAnalysis: result });
    const expectedUsedU = new Set(fixture.refs.flat());
    const expectedUsedFlags = new Set((fixture.flags || []).flat());
    equal([...usage.variables.U].sort((a, b) => a - b), [...expectedUsedU].sort((a, b) => a - b), `${name}: candidate occupied U set`);
    equal([...usage.personalFlags].sort((a, b) => a - b), [...expectedUsedFlags].sort((a, b) => a - b), `${name}: candidate occupied flag set`);
    for (const number of expectedUsedU) equal(unusedVariableCandidates('U', usage).includes(number), false, `${name}: U${number} cannot be recommended unused`);
    for (const number of expectedUsedFlags) equal(unusedPersonalFlagCandidates(usage).includes(number), false, `${name}: [${number}] cannot be recommended unused`);
    equal([...aggregate.candidates.variables.U].sort((a, b) => a - b), [...usage.variables.U].sort((a, b) => a - b), `${name}: list and standalone candidates agree`);
    if (fixture.complete) {
      equal([...usage.uncertainVariableFamilies], [], `${name}: a fully bounded fixture has no unknown U family`);
      equal(usage.personalFlagsUncertain, false, `${name}: a fully bounded fixture has no unknown flag family`);
    }
  } catch (error) {
    failures.push({ name, error });
  }
}

if (failures.length) {
  console.error(`variable-source-flow-branches.test.js: FAIL (${failures.length}/${cases} cases; ${checks} checks attempted)`);
  for (const { name, error } of failures) console.error(`- ${name}\n${error.stack || error}`);
  process.exitCode = 1;
} else {
  console.log(`variable-source-flow-branches.test.js: PASS (${cases} independent branch fixtures; ${checks} checks; production point analysis, final aggregation and candidate safety)`);
}
