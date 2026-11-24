// Deterministic eval: no model involved. Runs the expected tool call for each case
// and checks the answer against the frozen expected value and the reference SQL.
import { checkCase, evalContext, loadCases } from "./lib.ts";

const ctx = evalContext();
const results = loadCases().map((c) => checkCase(ctx, c));
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.detail}`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} cases passed`);
process.exit(passed === results.length ? 0 : 1);
