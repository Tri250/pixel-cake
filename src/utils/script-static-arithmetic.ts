import type { EngineId } from '../types';

const MAX_EXPRESSION_LENGTH = 2048;
const MAX_TOKENS = 512;
const MAX_DEPTH = 32;
const MAX_RATIONAL_BITS = 512;
// Beyond this boundary a floating-point engine can lose integer identity. Returning
// unknown is preferable to inventing a concrete U/flag index from a rounded value.
const MAX_EXACT_INTEGER = 9007199254740991n;

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

export type StaticNumericOperator = 'INC' | 'DEC' | 'MUL' | 'DIV';

/**
 * Evaluate only literal four-operation FORMULATION expressions. This is not a
 * script interpreter: variables must already have been substituted by the caller.
 * There is deliberately no eval, Function constructor, identifier or function call.
 *
 * GOM's own FORMULATION help specifies final ROUND with banker's rounding. GEE's
 * own excerpt does not establish rounding, so only integral final results are
 * accepted. 996PC documents default 四舍五入; negative fractional results remain
 * unknown because its negative-half convention has not been established. Its
 * optional truncation flag is not modeled by this two-argument API.
 *
 * Evidence: data/audit-report/language-accuracy-final.json commands.FORMULATION
 * (GOM/GEE), resolvedLanguage.engines['996PC'].FORMULATION documentation.
 */
export function evaluateStaticFormula(expression: string, engine?: EngineId): string | undefined {
  if (typeof expression !== 'string' || expression.length > MAX_EXPRESSION_LENGTH) return undefined;
  const parser = new StaticFormulaParser(expression);
  const value = parser.parse();
  if (!value) return undefined;
  // Exact rational mathematics is not a Delphi floating-point emulator. When an
  // intermediate is not exactly binary-representable, refuse unstable rounding
  // boundaries instead of turning a possible +/- floating error into a U index.
  if (parser.hasInexactIntermediate && !parser.isRoundingStable(value)) return undefined;
  if (value.denominator === 1n) {
    if (parser.hasInexactIntermediate && engine !== 'GOM' && engine !== '996PC') return undefined;
    return value.numerator.toString();
  }
  if (engine === 'GOM') return roundHalfEven(value);
  if (engine === '996PC' && value.numerator >= 0n) {
    const rounded = (value.numerator * 2n + value.denominator) / (2n * value.denominator);
    return integerResult(rounded);
  }
  return undefined;
}

/**
 * Numeric INC/DEC/MUL/DIV only; callers must check target type and the engine's
 * two/three-argument layout before using this helper. In particular, string/list
 * INC and DEC are not arithmetic. All inputs must be already resolved integers.
 *
 * GEE's own DIV help explicitly says 整除. Only nonnegative fractional division
 * is folded: negative integer division's rounding direction is not established.
 * GOM and 996PC DIV help gives no fractional convention, so a remainder is unknown
 * there rather than borrowing FORMULATION's final rounding rule.
 */
export function computeStaticNumericOperation(
  left: string,
  right: string,
  operator: StaticNumericOperator,
  engine?: EngineId,
): string | undefined {
  const leftInteger = parseInteger(left);
  const rightInteger = parseInteger(right);
  if (leftInteger === undefined || rightInteger === undefined) return undefined;
  switch (operator) {
    case 'INC': return integerResult(leftInteger + rightInteger);
    case 'DEC': return integerResult(leftInteger - rightInteger);
    case 'MUL': return integerResult(leftInteger * rightInteger);
    case 'DIV': {
      if (rightInteger === 0n) return undefined;
      const remainder = leftInteger % rightInteger;
      if (remainder !== 0n && (engine !== 'GEE' || leftInteger < 0n || rightInteger < 0n)) {
        return undefined;
      }
      return integerResult(leftInteger / rightInteger);
    }
    default: return undefined;
  }
}

function parseInteger(value: string): bigint | undefined {
  if (typeof value !== 'string' || value.length > MAX_EXPRESSION_LENGTH) return undefined;
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
  const normalized = trimmed.replace(/^[+-]?0+(?=\d)/, match => match.startsWith('-') ? '-' : '');
  if (normalized.length > 17) return undefined;
  const integer = BigInt(normalized);
  return abs(integer) <= MAX_EXACT_INTEGER ? integer : undefined;
}

function integerResult(value: bigint): string | undefined {
  return abs(value) <= MAX_EXACT_INTEGER ? value.toString() : undefined;
}

function roundHalfEven(value: Rational): string | undefined {
  const positive = abs(value.numerator);
  let whole = positive / value.denominator;
  const doubledRemainder = (positive % value.denominator) * 2n;
  if (doubledRemainder > value.denominator ||
      (doubledRemainder === value.denominator && whole % 2n !== 0n)) {
    whole++;
  }
  return integerResult(value.numerator < 0n ? -whole : whole);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function rational(numerator: bigint, denominator: bigint): Rational | undefined {
  if (denominator === 0n) return undefined;
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  let left = abs(numerator);
  let right = denominator;
  while (right !== 0n) {
    [left, right] = [right, left % right];
  }
  numerator /= left;
  denominator /= left;
  if (abs(numerator) > MAX_EXACT_INTEGER * denominator ||
      abs(numerator).toString(2).length > MAX_RATIONAL_BITS ||
      denominator.toString(2).length > MAX_RATIONAL_BITS) {
    return undefined;
  }
  return { numerator, denominator };
}

class StaticFormulaParser {
  private offset = 0;
  private tokenCount = 0;
  private largestMagnitude = 1;
  private sensitivity = 1;
  hasInexactIntermediate = false;

  constructor(private readonly expression: string) {}

  parse(): Rational | undefined {
    const result = this.parseExpression(0);
    this.skipWhitespace();
    return this.offset === this.expression.length ? result : undefined;
  }

  isRoundingStable(value: Rational): boolean {
    const fraction = Number(abs(value.numerator) % value.denominator) / Number(value.denominator);
    // Deliberately loose stability gate, not a claim to emulate the engine's
    // floating implementation. Cancellation/division amplify this guard; cases
    // too sensitive to establish a concrete rounded result simply stay unknown.
    const guard = Number.EPSILON * MAX_TOKENS * 16 * this.largestMagnitude * this.sensitivity;
    return Number.isFinite(guard) && guard < Math.abs(fraction - 0.5);
  }

  private observe(value: Rational | undefined): Rational | undefined {
    if (!value) return undefined;
    const denominator = value.denominator;
    if ((denominator & (denominator - 1n)) !== 0n || abs(value.numerator).toString(2).length > 53) {
      this.hasInexactIntermediate = true;
    }
    this.largestMagnitude = Math.max(this.largestMagnitude, this.magnitude(value));
    return value;
  }

  private magnitude(value: Rational): number {
    return Number(abs(value.numerator)) / Number(value.denominator);
  }

  private parseExpression(depth: number): Rational | undefined {
    let result = this.parseTerm(depth);
    if (!result) return undefined;
    while (true) {
      const operator = this.peek();
      if (operator !== '+' && operator !== '-') return result;
      if (!this.consumeToken()) return undefined;
      const right = this.parseTerm(depth);
      if (!right) return undefined;
      const signedRight = operator === '+' ? right.numerator : -right.numerator;
      result = this.observe(rational(
        result.numerator * right.denominator + signedRight * result.denominator,
        result.denominator * right.denominator,
      ));
      if (!result) return undefined;
    }
  }

  private parseTerm(depth: number): Rational | undefined {
    let result = this.parseUnary(depth);
    if (!result) return undefined;
    while (true) {
      const operator = this.peek();
      if (operator !== '*' && operator !== '/') return result;
      if (!this.consumeToken()) return undefined;
      const right = this.parseUnary(depth);
      if (!right) return undefined;
      const leftMagnitude = this.magnitude(result);
      const rightMagnitude = this.magnitude(right);
      this.sensitivity *= operator === '*'
        ? Math.max(1, leftMagnitude, rightMagnitude)
        : Math.max(1, 1 / rightMagnitude, leftMagnitude / (rightMagnitude * rightMagnitude));
      result = this.observe(operator === '*'
        ? rational(result.numerator * right.numerator, result.denominator * right.denominator)
        : rational(result.numerator * right.denominator, result.denominator * right.numerator));
      if (!result) return undefined;
    }
  }

  private parseUnary(depth: number): Rational | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const character = this.peek();
    if (character === '+' || character === '-') {
      if (!this.consumeToken()) return undefined;
      const value = this.parseUnary(depth + 1);
      if (!value) return undefined;
      return character === '-' ? { numerator: -value.numerator, denominator: value.denominator } : value;
    }
    if (character === '(') {
      if (!this.consumeToken()) return undefined;
      const value = this.parseExpression(depth + 1);
      if (!value || this.peek() !== ')' || !this.consumeToken()) return undefined;
      return value;
    }
    return this.parseNumber();
  }

  private parseNumber(): Rational | undefined {
    this.skipWhitespace();
    const start = this.offset;
    while (this.isDigit(this.expression[this.offset])) this.offset++;
    if (start === this.offset) return undefined;
    let decimalPlaces = 0;
    if (this.expression[this.offset] === '.') {
      this.offset++;
      const decimalStart = this.offset;
      while (this.isDigit(this.expression[this.offset])) this.offset++;
      decimalPlaces = this.offset - decimalStart;
      if (decimalPlaces === 0) return undefined;
    }
    const literal = this.expression.slice(start, this.offset);
    if (literal.length > 64 || ++this.tokenCount > MAX_TOKENS) return undefined;
    return this.observe(rational(BigInt(literal.replace('.', '')), 10n ** BigInt(decimalPlaces)));
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= '0' && character <= '9';
  }

  private peek(): string | undefined {
    this.skipWhitespace();
    return this.expression[this.offset];
  }

  private consumeToken(): boolean {
    this.offset++;
    return ++this.tokenCount <= MAX_TOKENS;
  }

  private skipWhitespace(): void {
    while (this.offset < this.expression.length && /\s/.test(this.expression[this.offset])) this.offset++;
  }
}
