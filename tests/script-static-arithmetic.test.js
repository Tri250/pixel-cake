const assert = require('node:assert/strict');

const {
  evaluateStaticFormula,
  computeStaticNumericOperation,
} = require('../out/utils/script-static-arithmetic');

const formulaCases = [
  ['20+5+5', 'GOM', '30'],
  ['(20+10)', 'GOM', '30'],
  ['2+3*4', 'GOM', '14'],
  ['(2+3)*4', 'GOM', '20'],
  ['20/5/2', 'GOM', '2'],
  ['20-(5-2)', 'GOM', '17'],
  ['-(20+10)+60', 'GOM', '30'],
  ['+(-(-30))', 'GOM', '30'],
  [' 20 + 10 ', 'GEE', '30'],
  ['0.1+0.2+29.7', 'GOM', '30'],
  ['1/3*90', 'GOM', '30'],
  // Only the final FORMULATION result is rounded, never each division.
  ['5/2+5/2', 'GOM', '5'],
  ['5/2', 'GOM', '2'],
  ['7/2', 'GOM', '4'],
  ['-5/2', 'GOM', '-2'],
  ['-7/2', 'GOM', '-4'],
  ['-1/2', 'GOM', '0'],
  ['3.6', 'GOM', '4'],
  ['3.4', 'GOM', '3'],
  ['0.25*10', 'GOM', '2'],
  ['0.1+0.2+0.3-0.1', 'GOM', undefined],
  ['0.1+0.4', 'GOM', undefined],
  ['1/3*7.5', 'GOM', undefined],
  ['(0.1-0.09999999999999999)*1000000000000000', 'GOM', undefined],
  // GEE's own FORMULATION excerpt does not establish a rounding mode.
  ['5/2', 'GEE', undefined],
  ['1/2+1/2', 'GEE', '1'],
  ['5/2', undefined, undefined],
  ['20+10', undefined, '30'],
  // 996PC's own help documents default rounding, not GOM's half-even.
  ['155/100', '996PC', '2'],
  ['5/2', '996PC', '3'],
  ['7/2', '996PC', '4'],
  ['-5/2', '996PC', undefined],
  ['-6/2', '996PC', '-3'],
  ['00030', 'GOM', '30'],
  ['-0', 'GOM', '0'],
  ['9007199254740991', 'GOM', '9007199254740991'],
  ['9007199254740990+1', 'GOM', '9007199254740991'],
  ['9007199254740991-9007199254740990', 'GOM', '1'],
  ['9007199254740992', 'GOM', undefined],
  ['9007199254740991+1', 'GOM', undefined],
  ['9007199254740991*2-9007199254740991', 'GOM', undefined],
  ['1/(3-3)', 'GOM', undefined],
  ['0/0', 'GOM', undefined],
  ['1/0+30', 'GOM', undefined],
];

for (const [expression, engine, expected] of formulaCases) {
  assert.equal(evaluateStaticFormula(expression, engine), expected, `${engine}: ${expression}`);
}

const rejected = [
  '', ' ', '.', '1.', '.5', '1e3', '0x10', 'NaN', 'Infinity',
  '1 2', '2(3)', '(1', '1)', '()', '1+', '*2',
  '1%2', '1^2', '1**2', '1//2', '1/*x*/2',
  'MIN(1,2)', 'RANDOM(1,20)', '<$STR(N1)>', 'N1+10',
  'globalThis.__booArithmeticExecuted = true', 'process.exit()',
  '1;2', '1,2', '1\u00002',
  '('.repeat(80) + '1' + ')'.repeat(80),
  '-'.repeat(80) + '1',
  '1+'.repeat(256) + '1',
  '1+'.repeat(3000) + '1',
  '9'.repeat(2000),
];
globalThis.__booArithmeticExecuted = false;
for (const expression of rejected) {
  assert.equal(evaluateStaticFormula(expression, 'GOM'), undefined, expression.slice(0, 80));
}
assert.equal(globalThis.__booArithmeticExecuted, false);
delete globalThis.__booArithmeticExecuted;
assert.equal(evaluateStaticFormula('1/2', 'UNKNOWN'), undefined);

const numericCases = [
  ['20', '10', 'INC', 'GOM', '30'],
  ['20', '10', 'DEC', 'GOM', '10'],
  ['-20', '10', 'INC', 'GEE', '-10'],
  ['20', '-10', 'DEC', 'GEE', '30'],
  ['20', '10', 'MUL', '996PC', '200'],
  ['30', '10', 'DIV', 'GOM', '3'],
  ['-30', '10', 'DIV', 'GOM', '-3'],
  ['5', '2', 'DIV', 'GOM', undefined],
  ['5', '2', 'DIV', '996PC', undefined],
  ['5', '2', 'DIV', 'GEE', '2'],
  ['-5', '2', 'DIV', 'GEE', undefined],
  ['-6', '2', 'DIV', 'GEE', '-3'],
  ['5', '0', 'DIV', 'GEE', undefined],
  ['9007199254740990', '1', 'INC', 'GOM', '9007199254740991'],
  ['9007199254740991', '1', 'INC', 'GOM', undefined],
  ['9007199254740992', '0', 'INC', 'GOM', undefined],
  ['20.5', '10', 'INC', 'GOM', undefined],
  ['20', '<$STR(N1)>', 'INC', 'GOM', undefined],
  ['20+1', '10', 'INC', 'GOM', undefined],
  ['20', '10', 'UNKNOWN', 'GOM', undefined],
];
for (const [left, right, operator, engine, expected] of numericCases) {
  assert.equal(computeStaticNumericOperation(left, right, operator, engine), expected,
    `${engine}: ${left} ${operator} ${right}`);
}

// Independent finite integer oracle: expected values are computed from the input
// integers, not by reproducing the production expression parser or rounding code.
let oracleCases = 0;
for (let left = -12; left <= 12; left++) {
  for (let right = -8; right <= 8; right++) {
    const expected = ((BigInt(left) + BigInt(right)) * 3n - BigInt(left)).toString();
    assert.equal(evaluateStaticFormula(`(${left}+(${right}))*3-(${left})`, 'GOM'), expected);
    oracleCases++;
    if (right !== 0) {
      assert.equal(evaluateStaticFormula(`(${left}*(${right}))/(${right})`, 'GEE'), String(left));
      oracleCases++;
    }
  }
}

console.log(`Static arithmetic tests passed (${formulaCases.length + rejected.length + numericCases.length + oracleCases + 2} cases)`);
