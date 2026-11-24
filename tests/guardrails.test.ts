import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decideProposal } from "../src/approval.ts";
import { openState } from "../src/db.ts";
import { PROJECT_ROOT } from "../src/paths.ts";
import { TOOLS } from "../src/tools.ts";
import { ok, rejected, testContext, testFiles } from "./helpers.ts";

const ctx = testContext();
const JAN = { start_date: "2026-01-01", end_date: "2026-01-31" };
const PROPOSAL = {
  campaign: "Meta Retargeting",
  change_percent: 10,
  rationale: "Lowest cost per member of the Meta campaigns in Q1.",
};

test("unknown metric is rejected", () => {
  assert.match(rejected(ctx, "query_metric", { metric: "roas", ...JAN }), /metric: Invalid option/);
});

test("unknown dimension is rejected", () => {
  assert.match(rejected(ctx, "query_metric", { metric: "spend", ...JAN, dimensions: ["device"] }), /dimensions\.0/);
});

test("a dimension the metric does not allow is rejected", () => {
  const error = rejected(ctx, "query_metric", { metric: "cost_per_member", ...JAN, dimensions: ["day"] });
  assert.match(error, /"day" is not allowed for metric "cost_per_member"/);
});

test("there is no way to pass SQL", () => {
  assert.match(rejected(ctx, "query_metric", { metric: "spend", ...JAN, sql: "SELECT 1" }), /Unrecognized key/);
  assert.match(rejected(ctx, "query_metric", { metric: "SUM(spend_cents)", ...JAN }), /Invalid option/);
  const error = rejected(ctx, "query_metric", {
    metric: "spend", ...JAN, filters: { location: ["Downtown'; DROP TABLE leads; --"] },
  });
  assert.match(error, /Unknown location/);
});

test("bad dates are rejected", () => {
  assert.match(rejected(ctx, "query_metric", { metric: "spend", start_date: "Jan 1", end_date: "2026-01-31" }), /YYYY-MM-DD/);
  assert.match(rejected(ctx, "query_metric", { metric: "spend", start_date: "2026-02-30", end_date: "2026-03-01" }), /not a real calendar date/);
  assert.match(rejected(ctx, "query_metric", { metric: "spend", start_date: "2026-02-01", end_date: "2026-01-01" }), /is after/);
  assert.match(rejected(ctx, "query_metric", { metric: "spend", ...JAN, dimensions: ["week", "month"] }), /one date grain/);
  assert.match(
    rejected(ctx, "compare_periods", { metric: "spend", period_a: JAN, period_b: JAN, dimensions: ["month"] }),
    /does not take a date grain/,
  );
});

test("unknown tool is rejected", () => {
  assert.match(rejected(ctx, "run_sql", { sql: "SELECT 1" }), /Unknown tool/);
});

test("the warehouse connection is read-only", () => {
  assert.throws(() => ctx.warehouse.exec("DELETE FROM leads"), /readonly/);
});

test("budget proposals are validated", () => {
  assert.match(rejected(ctx, "propose_budget_change", { ...PROPOSAL, change_percent: 80 }), /change_percent/);
  assert.match(rejected(ctx, "propose_budget_change", { ...PROPOSAL, change_percent: 0 }), /not a change/);
  assert.match(rejected(ctx, "propose_budget_change", { ...PROPOSAL, rationale: "trust me" }), /rationale/);
  assert.match(rejected(ctx, "propose_budget_change", { ...PROPOSAL, campaign: "Everything" }), /Unknown campaign/);
});

test("a proposal stays pending and no tool input can change that", () => {
  const { proposal } = ok(ctx, "propose_budget_change", PROPOSAL);
  assert.equal(proposal.status, "pending");
  assert.match(rejected(ctx, "propose_budget_change", { ...PROPOSAL, status: "approved" }), /Unrecognized key/);
  assert.match(rejected(ctx, "list_proposals", { status: "pending", approve: proposal.id }), /Unrecognized key/);
  const listed = ok(ctx, "list_proposals", {}).proposals;
  assert.deepEqual(listed.map((p: { status: string }) => p.status), ["pending"]);
});

test("no path from the tools to approval", () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ["list_metrics", "query_metric", "compare_periods", "explain_metric", "propose_budget_change", "list_proposals"],
  );
  // Only the CLI may import the approval module, and only approval.ts may update a proposal.
  const src = join(PROJECT_ROOT, "src");
  for (const file of readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "approval.ts")) {
    const source = readFileSync(join(src, file), "utf8");
    assert.ok(!/approval\.ts|decideProposal/.test(source), `${file} must not reach the approval module`);
    assert.ok(!/UPDATE proposals/i.test(source), `${file} must not update proposals`);
  }
  assert.match(readFileSync(join(src, "cli", "decide.ts"), "utf8"), /approval\.ts/);
});

test("the approval module decides a pending proposal once", () => {
  const { proposal } = ok(ctx, "propose_budget_change", PROPOSAL);
  const decided = decideProposal(ctx.state, { id: proposal.id, decision: "approved", decidedBy: "test" });
  assert.equal(decided.status, "approved");
  assert.throws(
    () => decideProposal(ctx.state, { id: proposal.id, decision: "rejected", decidedBy: "test" }),
    /already approved/,
  );
});

test("the approve command refuses to run without an interactive terminal", () => {
  const files = testFiles();
  const state = openState(files.state);
  state.prepare("INSERT INTO proposals (created_at, campaign, change_percent, rationale) VALUES ('2026-07-01', 'Meta Retargeting', 10, 'test')").run();
  const run = spawnSync(process.execPath, [join(PROJECT_ROOT, "src", "cli", "decide.ts"), "approve", "1"], {
    env: { ...process.env, STATE_DB: files.state },
    input: "approve 1\n",
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Refusing to decide without an interactive terminal/);
  assert.equal(state.prepare("SELECT status FROM proposals WHERE id = 1").get()?.status, "pending");
});

test("every tool call is written to an append-only audit log", () => {
  const fresh = testContext();
  ok(fresh, "query_metric", { metric: "spend", ...JAN });
  rejected(fresh, "query_metric", { metric: "roas", ...JAN });
  const log = fresh.state.prepare("SELECT action, ok, detail FROM audit_log ORDER BY id").all();
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((entry) => entry.ok), [1, 0]);
  assert.match(String(log[1]?.detail), /Invalid option/);
  assert.throws(() => fresh.state.exec("UPDATE audit_log SET ok = 1"), /append-only/);
  assert.throws(() => fresh.state.exec("DELETE FROM audit_log"), /append-only/);
});
