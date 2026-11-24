# marketing-analyst-mcp

An example MCP server that lets an AI assistant answer marketing performance questions from a small warehouse. The assistant does not write SQL. It picks from a fixed list of metrics, and the server builds the query.

**Read this first**

- The data is synthetic. A seeded script generates every row.
- The business, "Harbour Fitness" with 12 gym locations, is fictional.
- This is an example to show an approach. It is not a production system and it has not been used in one.

## The idea

I work in marketing operations and data. A common request there is to let an assistant answer questions like "what was our cost per lead last month". This project shows three ideas I think that needs.

1. **Governed metrics instead of free SQL.** If the model writes SQL, it also decides what "cost per lead" means, and it can decide differently each time. Here every metric is defined once in [`src/registry.ts`](src/registry.ts), with a plain-language definition and the dimensions it allows. The tools accept a metric name, dimensions, filters and dates. They build one parameterised query from the registry. There is no tool that takes SQL.
2. **Evaluation before trust.** [`evals/cases.json`](evals/cases.json) holds 20 cases. Each question has the expected tool call and the expected answer. The tests check that the tool layer returns those answers and that the guardrails hold.
3. **A person approves changes.** The assistant can record a budget proposal with a rationale. It cannot approve one. Approval is a separate command that a person runs in a terminal.

Every tool call, accepted or rejected, is written to an append-only audit log.

## The data

Ad spend on Google and Meta across 6 campaigns and 12 locations, from 2026-01-01 to 2026-06-30. Leads become trials, and trials become members.

| Table | What it holds |
| --- | --- |
| `locations` | 12 gym locations |
| `campaigns` | 6 campaigns with their channel (google or meta) |
| `ad_spend` | Daily spend per campaign and location |
| `leads` | One row per lead, with trial and member dates when they exist |

`npm run build:db` writes `data/warehouse.db`. The seed is fixed, so the same rows come out every time. The server opens this file read-only.

## Run it

You need Node 24 or newer. Node runs the TypeScript files directly, and SQLite comes from the built-in `node:sqlite` module, so there is no build step and no native dependency.

```bash
npm install
npm run build:db    # create the synthetic warehouse
npm test            # tool layer, guardrails, stdio server
npm run eval        # deterministic eval, prints one line per case
npm start           # start the MCP server on stdio
```

### Add it to Claude Code

```bash
claude mcp add marketing-analyst -- node /absolute/path/to/marketing-analyst-mcp/src/server.ts
```

### Add it to Claude Desktop

Add this to `claude_desktop_config.json` and restart the app:

```json
{
  "mcpServers": {
    "marketing-analyst": {
      "command": "node",
      "args": ["/absolute/path/to/marketing-analyst-mcp/src/server.ts"]
    }
  }
}
```

If the `node` that Claude Desktop finds is older than 24, put the full path to a newer Node binary in `command`.

Then ask something like "What was cost per lead by channel in March 2026?".

## Metrics

| Metric | Definition |
| --- | --- |
| `spend` | Total ad spend in dollars, by the day the spend happened |
| `leads` | Number of leads, by the date the lead was created |
| `cost_per_lead` | Spend divided by leads |
| `trials` | Leads that started a free trial |
| `members` | Leads that became paying members |
| `cost_per_member` | Spend divided by members |
| `lead_to_member_rate` | Members divided by leads, as a fraction |

Dimensions: `day`, `week`, `month`, `channel`, `campaign`, `location`. Filters: `channel`, `campaign`, `location`.

Trials and members are counted by the date the lead was created. This is a cohort view. It keeps the ratios consistent, but recent periods look worse than they are because some leads have not converted yet. The two member ratios do not allow the `day` grain, because one day of leads is too small to read.

## Tools

| Tool | What it does |
| --- | --- |
| `list_metrics` | Lists metrics, definitions, allowed dimensions, filter values and the date range of the data |
| `query_metric` | Returns one metric for a date range, with optional dimensions, filters, sort and limit |
| `compare_periods` | Returns one metric for two date ranges, with the change and percent change |
| `explain_metric` | Returns the definition and the exact SQL and parameters that `query_metric` would run |
| `propose_budget_change` | Records a pending proposal: campaign, percent change (between -50 and 50) and rationale |
| `list_proposals` | Lists proposals and their status |

Inputs are validated with zod. Unknown metrics, unknown dimensions, extra fields, impossible dates and unknown filter values are rejected with a message that says what is allowed.

Example call and result from the seeded data:

```json
{ "metric": "cost_per_lead", "start_date": "2026-03-01", "end_date": "2026-03-31", "dimensions": ["channel"] }
```

```json
{ "rows": [ { "channel": "google", "value": 24.53 }, { "channel": "meta", "value": 19.75 } ] }
```

## Approving a proposal

Proposals and the audit log live in `data/state.db`, separate from the warehouse.

```bash
npm run proposals             # list proposals
npm run approve -- 1 "ok"     # approve proposal 1, with an optional note
npm run reject -- 1           # reject proposal 1
```

The command shows the proposal and asks you to type `approve 1` to confirm. It refuses to run without an interactive terminal. The code that changes a proposal's status is in `src/approval.ts`. Only the CLI imports it, and a test fails if the tool layer or the server ever does.

Approving only records the decision. This example is not connected to any ad platform, so nothing is applied anywhere.

To read the audit log:

```bash
sqlite3 data/state.db "SELECT at, actor, action, ok, detail FROM audit_log"
```

## How the evals work

Each case in `evals/cases.json` has a question, the expected tool call, where the answer sits in the result, and the expected answer. Most cases also carry `reference_sql`: a hand-written query against the raw tables that does not use the registry. I filled in the expected values from that reference SQL and froze them in the file.

**Deterministic mode** (`npm run eval`, also part of `npm test` and CI). No model is involved. For each case it runs the expected tool call and checks three things agree: the tool result, the frozen expected value, and the reference SQL. Three of the cases are guardrails that must be rejected. The tests add more guardrail checks: no SQL input, read-only warehouse, proposal limits, append-only audit log, and no path from the tools to approval.

This mode tells you the tool layer is correct. It says nothing about whether a model picks the right tool.

**Model mode** (`npm run eval:model`, optional). This needs `ANTHROPIC_API_KEY` and costs money. It sends each of the 17 non-guardrail questions to Claude with the same tools, runs the tool calls in process, and scores two things:

- Tool choice: did the model make a successful call to the expected tool for the expected metric.
- Answer: does the final `ANSWER:` line match the expected value within tolerance. Two cases (the explanation and the proposal) are scored on tool choice only.

The default model is `claude-sonnet-5-5`. Set `EVAL_MODEL` to change it. Details for each run go to `evals/results/`, which is git-ignored.

The model eval is included, but **no model scores are published in this repo**. If you run it, the scores are yours.

## Project layout

```
src/registry.ts      metrics, dimensions and their SQL (the only place metric SQL lives)
src/query.ts         builds and runs the parameterised query
src/tools.ts         tool definitions, input validation, audit logging
src/server.ts        MCP server over stdio
src/proposals.ts     create and list proposals (used by tools)
src/approval.ts      approve or reject (used only by the CLI)
src/cli/             build-db and the approve/reject command
src/seed.ts          synthetic data generator
evals/               cases, deterministic runner, model runner
tests/               node:test suites
```

## Limits

- **Small and fake.** About 20,000 leads and six months of data. Real ad data has late-arriving conversions, attribution windows, currency issues and platform discrepancies. None of that is modelled.
- **Seven metrics.** No revenue, no return on ad spend, no impressions or clicks. One attribution rule (lead creation date), fixed in the registry.
- **The approval boundary is a process boundary, not a security boundary.** The server has no approval tool, and the CLI wants a person at a terminal. But an assistant that can run shell commands on the same machine, or write to `data/state.db`, could get around it. A real setup needs authentication and a separate service for approvals.
- **Approval applies nothing.** There is no ad platform integration. A proposal is a row in a table.
- **The audit log is append-only by SQLite trigger.** That stops accidental edits. It does not stop someone with file access.
- **No auth, no multi-user support, stdio only.** It is meant to run locally for one person.
- **The model eval is thin.** 17 questions, one run each, exact-match scoring on a final line. It does not measure variance, phrasing sensitivity or wrong-but-plausible explanations. No scores are published here.
- **The deterministic eval shares one author.** I wrote both the registry SQL and the reference SQL. They are independent queries, but the same person could make the same mistake twice.
- **MCP SDK version.** It uses `@modelcontextprotocol/sdk` 1.x with the low-level `Server` class, so that rejected calls are also written to the audit log. The SDK marks that class as deprecated in favour of `McpServer`, and a 2.x SDK exists under different package names. I have not ported it.
- **Tested on Node 26 on macOS.** The CI workflow uses Node 24 on Linux.

## License

MIT. See [LICENSE](LICENSE).
