import assert from "node:assert/strict";
import { test } from "node:test";
import { answerCorrect, checkCase, loadCases, toolChoiceCorrect } from "../evals/lib.ts";
import { DIMENSION_NAMES, METRIC_NAMES, METRICS } from "../src/registry.ts";
import { ok, testContext, testFiles } from "./helpers.ts";
import { openWarehouse } from "../src/db.ts";

const ctx = testContext();
const H1 = { start_date: "2026-01-01", end_date: "2026-06-30" };

test("the seed is deterministic", () => {
  const fingerprint = (path: string) =>
    openWarehouse(path)
      .prepare(
        "SELECT (SELECT SUM(spend_cents) FROM ad_spend) AS cents, (SELECT COUNT(*) FROM leads) AS leads, (SELECT COUNT(member_date) FROM leads) AS members",
      )
      .get();
  assert.deepEqual(fingerprint(testFiles().warehouse), fingerprint(testFiles().warehouse));
});

test("eval cases: the tool layer returns the expected answers", async (t) => {
  for (const c of loadCases()) {
    await t.test(c.id, () => {
      const result = checkCase(ctx, c);
      assert.ok(result.pass, result.detail);
    });
  }
});

test("list_metrics describes every metric, the filter values and the data range", () => {
  const result = ok(ctx, "list_metrics", {});
  assert.deepEqual(result.metrics.map((m: { name: string }) => m.name), METRIC_NAMES);
  assert.equal(result.filter_values.location.length, 12);
  assert.deepEqual(result.filter_values.channel, ["google", "meta"]);
  assert.deepEqual(result.data_coverage, H1);
});

test("every metric runs with every dimension it allows", () => {
  for (const metric of METRIC_NAMES) {
    for (const dimension of METRICS[metric].dimensions) {
      const result = ok(ctx, "query_metric", { metric, ...H1, dimensions: [dimension], limit: 1000 });
      assert.ok(result.row_count > 0, `${metric} by ${dimension} returned no rows`);
    }
  }
});

test("groups add up to the total", () => {
  const total = ok(ctx, "query_metric", { metric: "leads", ...H1 }).rows[0].value;
  for (const dimension of DIMENSION_NAMES) {
    const rows = ok(ctx, "query_metric", { metric: "leads", ...H1, dimensions: [dimension], limit: 1000 }).rows;
    const sum = rows.reduce((n: number, row: { value: number }) => n + row.value, 0);
    assert.equal(sum, total, `leads by ${dimension}`);
  }
});

test("limit cuts the result and says so", () => {
  const result = ok(ctx, "query_metric", { metric: "spend", ...H1, dimensions: ["location"], limit: 5 });
  assert.equal(result.row_count, 5);
  assert.equal(result.truncated, true);
});

test("compare_periods agrees with two query_metric calls", () => {
  const a = { start_date: "2026-03-01", end_date: "2026-03-31" };
  const b = { start_date: "2026-04-01", end_date: "2026-04-30" };
  const compared = ok(ctx, "compare_periods", { metric: "spend", period_a: a, period_b: b, dimensions: ["channel"] });
  const byChannel = (period: typeof a) =>
    ok(ctx, "query_metric", { metric: "spend", ...period, dimensions: ["channel"] }).rows;
  assert.equal(compared.rows.length, 2);
  for (const [i, row] of compared.rows.entries()) {
    const valueA = byChannel(a)[i].value;
    const valueB = byChannel(b)[i].value;
    assert.equal(row.period_a, valueA);
    assert.equal(row.period_b, valueB);
    assert.equal(row.change, Number((valueB - valueA).toFixed(2)));
    assert.equal(row.pct_change, Number(((valueB - valueA) / valueA).toFixed(4)));
  }
});

test("explain_metric returns the SQL that query_metric runs", () => {
  const args = { metric: "cost_per_member", ...H1, dimensions: ["channel"], filters: { location: ["Midtown"] } };
  const explained = ok(ctx, "explain_metric", args);
  assert.match(explained.definition, /Ad spend divided by members/);
  assert.match(explained.sql, /NULLIF\(SUM\(members\), 0\)/);
  assert.ok(!explained.sql.includes("Midtown"), "filter values must be bound, not written into the SQL");
  const rows = ctx.warehouse.prepare(explained.sql).all(...explained.params);
  const viaTool = ok(ctx, "query_metric", args).rows;
  assert.deepEqual(rows.map((r) => ({ ...r })), viaTool.map((r: object) => ({ ...r })));
});

test("model eval scoring helpers", () => {
  const number = { id: "x", question: "", tool: "query_metric", args: { metric: "spend" }, expected: 1234.5 };
  assert.equal(answerCorrect(number, "Spend was high.\nANSWER: 1234.50"), true);
  assert.equal(answerCorrect(number, "ANSWER: $1,234.50"), true);
  assert.equal(answerCorrect(number, "ANSWER: 1300"), false);
  assert.equal(answerCorrect(number, "It was 1234.5"), false);
  assert.equal(answerCorrect({ ...number, expected: 0.1102, tolerance: 0.0005 }, "ANSWER: 11.02%"), true);
  assert.equal(answerCorrect({ ...number, expected: "Meta" }, "ANSWER: meta"), true);
  assert.equal(toolChoiceCorrect(number, [{ name: "query_metric", input: { metric: "spend" }, ok: true }]), true);
  assert.equal(toolChoiceCorrect(number, [{ name: "query_metric", input: { metric: "leads" }, ok: true }]), false);
  assert.equal(toolChoiceCorrect(number, [{ name: "query_metric", input: { metric: "spend" }, ok: false }]), false);
});
