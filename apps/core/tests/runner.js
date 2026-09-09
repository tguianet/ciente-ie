// apps/core/tests/runner.js
// Test runner leve — sem dependências externas. Roda em browser (ES module).

let _passed = 0;
let _failed = 0;

export function test(name, fn) {
  try {
    fn();
    _passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    _failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${e.message}`);
  }
}

export function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`\n  Expected: ${b}\n  Got:      ${a}`);
    },
    toContain(item) {
      if (!Array.isArray(actual) || !actual.includes(item))
        throw new Error(`Expected array to contain ${JSON.stringify(item)}, got ${JSON.stringify(actual)}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    toBeGreaterThan(n) {
      if (!(actual > n)) throw new Error(`Expected ${actual} > ${n}`);
    },
    toBeLessThan(n) {
      if (!(actual < n)) throw new Error(`Expected ${actual} < ${n}`);
    },
  };
}

export function summary() {
  const total = _passed + _failed;
  console.log(`\n──────────────────────────────────────`);
  console.log(`${total} testes: ${_passed} ✓  ${_failed} ✗`);
  if (_failed > 0) console.error('Alguns testes falharam.');
}
