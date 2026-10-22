const assert = require('node:assert/strict');
const { analyzeNestedVariables } = require('../out/utils/nested-variable-analysis');

// An independent finite execution oracle: for each concrete truth value, execute
// only that polarity's synthetic ACT sections, preserving SAY as an observation.
// It does not reuse production CFG builders, arithmetic helpers, or branch logic.
const started = Date.now();
const modes = ['ACT', 'SAY', 'ELSEACT', 'ELSESAY'];
let checked = 0;
const failures = [];

for (let length = 1; length <= 5; length++) {
  for (let mask = 0; mask < 4 ** length; mask++) {
    let code = mask;
    const sequence = Array.from({ length }, () => {
      const mode = modes[code % 4];
      code = Math.floor(code / 4);
      return mode;
    });
    const stops = [-1, ...sequence.flatMap((mode, index) => mode.endsWith('ACT') ? [index] : [])];
    for (const stopIndex of stops) {
      const lines = ['[@main]', 'MOV N$idx 10', '#IF', 'CHECKLEVEL 1'];
      const observations = [];
      sequence.forEach((mode, index) => {
        lines.push('#' + mode);
        if (mode.endsWith('ACT')) lines.push('INC N$idx ' + (index + 1));
        observations.push({ line: lines.length, section: index });
        lines.push('EQUAL U<$STR(N$idx)> 0');
        if (index === stopIndex) lines.push('BREAK');
      });
      lines.push('#IF', 'CHECKLEVEL 2', '#ACT');
      const endLine = lines.length;
      lines.push('EQUAL U<$STR(N$idx)> 0');
      const expected = new Map(observations.map(observation => [observation.line, new Set()]));
      expected.set(endLine, new Set());
      for (const truth of [true, false]) {
        let value = 10;
        let active = true;
        sequence.forEach((mode, index) => {
          if (!active || mode.startsWith('ELSE') === truth) return;
          if (mode.endsWith('ACT')) value += index + 1;
          expected.get(observations[index].line).add('U' + value);
          if (index === stopIndex) active = false;
        });
        if (active) expected.get(endLine).add('U' + value);
      }
      for (const engine of ['GOM', 'GEE', '996PC']) {
        const actual = analyzeNestedVariables(lines.join('\n'), { engine });
        assert.equal(actual.references.length, expected.size, 'oracle must not pass vacuously if references disappear');
        for (const reference of actual.references) {
          const wanted = [...expected.get(reference.line)].sort();
          // Unreachable expressions remain unresolved. Reachable known may-values
          // must contain precisely both independent concrete branch executions.
          if (JSON.stringify([...reference.variables].sort()) !== JSON.stringify(wanted)) {
            failures.push({
              engine, sequence, stopIndex, line: reference.line,
              wanted, got: reference.variables, status: reference.status,
            });
            break;
          }
        }
        checked++;
      }
      if (failures.length >= 5) break;
    }
    if (failures.length >= 5) break;
  }
  if (failures.length >= 5) break;
}

console.log(JSON.stringify({ checked, elapsedMs: Date.now() - started, failures }, null, 2));
if (failures.length) process.exitCode = 1;
