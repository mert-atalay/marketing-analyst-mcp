// Shared by the deterministic eval, the model eval and the tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openState, openWarehouse, type Context } from "../src/db.ts";
import { PROJECT_ROOT } from "../src/paths.ts";
import { callTool } from "../src/tools.ts";

export interface EvalCase {
  id: string;
  question: string;
  tool: string;
  args: Record<string, unknown>;
  // Where the answer sits in the tool result. With "where", the first matching row is used.
  extract?: { where?: Record<string, string>; field: string };
  expected?: number | string;
  expected_contains?: string;
  tolerance?: number;
  // Hand-written SQL that computes the same answer without the metric registry.
  reference_sql?: string;
  // Guardrail cases: the call must fail with this text in the error.
  expect_error?: string;
  score_answer_with_model?: boolean;
}

export const DEFAULT_TOLERANCE = 0.005;

export function loadCases(): EvalCase[] {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, "evals", "cases.json"), "utf8")) as EvalCase[];
}

// The warehouse plus a throwaway in-memory state database, so evals leave no proposals behind.
export function evalContext(warehouse?: string): Context {
  return { warehouse: openWarehouse(warehouse), state: openState(":memory:") };
}

export function extract(result: unknown, spec: NonNullable<EvalCase["extract"]>): unknown {
  let node = result as Record<string, unknown>;
  if (Array.isArray(node.rows)) {
    const rows = node.rows as Record<string, unknown>[];
    const where = Object.entries(spec.where ?? {});
    node = rows.find((row) => where.every(([key, value]) => row[key] === value)) ?? {};
  }
  return spec.field.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], node);
}

export function matches(expected: number | string, actual: unknown, tolerance = DEFAULT_TOLERANCE): boolean {
  if (typeof expected === "number") {
    return typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
  }
  return typeof actual === "string" && actual.trim().toLowerCase() === expected.toLowerCase();
}

export interface CaseResult {
  id: string;
  pass: boolean;
  detail: string;
}

export function checkCase(ctx: Context, c: EvalCase): CaseResult {
  const outcome = callTool(ctx, c.tool, c.args, "eval");
  const fail = (detail: string): CaseResult => ({ id: c.id, pass: false, detail });

  if (c.expect_error !== undefined) {
    if (outcome.ok) return fail("expected the call to be rejected, but it succeeded");
    return outcome.error.includes(c.expect_error)
      ? { id: c.id, pass: true, detail: `rejected: ${outcome.error}` }
      : fail(`rejected with a different error: ${outcome.error}`);
  }
  if (!outcome.ok) return fail(`tool error: ${outcome.error}`);
  const actual = extract(outcome.result, c.extract!);

  if (c.expected_contains !== undefined) {
    return String(actual).includes(c.expected_contains)
      ? { id: c.id, pass: true, detail: `contains "${c.expected_contains}"` }
      : fail(`"${String(actual)}" does not contain "${c.expected_contains}"`);
  }
  if (c.expected === undefined) return fail("case has no expected value");
  if (!matches(c.expected, actual, c.tolerance)) {
    return fail(`tool returned ${JSON.stringify(actual)}, expected ${JSON.stringify(c.expected)}`);
  }
  if (c.reference_sql) {
    const reference = ctx.warehouse.prepare(c.reference_sql).get()?.answer;
    if (!matches(c.expected, reference, c.tolerance)) {
      return fail(`reference SQL returned ${JSON.stringify(reference)}, expected ${JSON.stringify(c.expected)}`);
    }
  }
  return { id: c.id, pass: true, detail: `${JSON.stringify(actual)}` };
}

// Scoring for the model eval.

export interface ToolCall {
  name: string;
  input: unknown;
  ok: boolean;
}

// Correct when the model made a successful call to the expected tool for the expected metric.
// Different arguments are fine as long as the answer comes out right.
export function toolChoiceCorrect(c: EvalCase, calls: ToolCall[]): boolean {
  return calls.some((call) => {
    const metric = (call.input as { metric?: unknown } | null)?.metric;
    return call.ok && call.name === c.tool && (c.args.metric === undefined || metric === c.args.metric);
  });
}

export function answerCorrect(c: EvalCase, text: string): boolean {
  const answer = text.match(/ANSWER:\s*(.+)\s*$/im)?.[1]?.trim();
  if (answer === undefined || c.expected === undefined) return false;
  if (typeof c.expected === "string") return answer.toLowerCase().includes(c.expected.toLowerCase());
  const value = Number(answer.replace(/[$,%\s]/g, ""));
  if (Number.isNaN(value)) return false;
  const tolerance = c.tolerance ?? DEFAULT_TOLERANCE;
  // A rate given as a percent (11.02%) is accepted for a fraction (0.1102).
  const candidates = answer.includes("%") ? [value, value / 100] : [value];
  return candidates.some((v) => Math.abs(v - (c.expected as number)) <= tolerance);
}
