// Tool definitions shared by the MCP server, the tests and the evals.
// Every call goes through callTool, which validates the input and writes the audit log.
import { z } from "zod";
import { writeAudit, type Context } from "./db.ts";
import { createProposal, listProposals } from "./proposals.ts";
import {
  comparePeriods, dataCoverage, explainMetric, knownFilterValues, queryMetric, ToolInputError,
} from "./query.ts";
import { DIMENSION_NAMES, DIMENSIONS, METRIC_NAMES, METRICS } from "./registry.ts";

const metric = z.enum(METRIC_NAMES).describe("A metric name from list_metrics.");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const dimensions = z
  .array(z.enum(DIMENSION_NAMES))
  .max(3)
  .describe("Dimensions to group by. Leave empty for a single total.");
const values = z.array(z.string().min(1)).min(1).max(20);
const filters = z
  .strictObject({ channel: values.optional(), campaign: values.optional(), location: values.optional() })
  .describe("Keep only rows that match these values. Values must match list_metrics exactly.");
const period = z.strictObject({ start_date: date, end_date: date });

interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  run: (args: z.infer<S>, ctx: Context) => unknown;
}

function tool<S extends z.ZodType>(definition: ToolDefinition<S>): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

export const TOOLS: ToolDefinition[] = [
  tool({
    name: "list_metrics",
    description:
      "List the governed metrics with their definitions and allowed dimensions, the filter values, and the date range the data covers. Call this first.",
    input: z.strictObject({}),
    run: (_args, ctx) => ({
      metrics: METRIC_NAMES.map((name) => ({
        name,
        label: METRICS[name].label,
        unit: METRICS[name].unit,
        definition: METRICS[name].definition,
        allowed_dimensions: METRICS[name].dimensions,
      })),
      dimensions: DIMENSION_NAMES.map((name) => ({ name, description: DIMENSIONS[name].description })),
      filter_values: knownFilterValues(ctx.warehouse),
      data_coverage: dataCoverage(ctx.warehouse),
    }),
  }),
  tool({
    name: "query_metric",
    description:
      "Get one governed metric for a date range, optionally grouped by dimensions and filtered. Dates are inclusive.",
    input: z.strictObject({
      metric,
      start_date: date,
      end_date: date,
      dimensions: dimensions.optional(),
      filters: filters.optional(),
      sort: z.enum(["dimensions", "value_desc", "value_asc"]).optional().describe("Default: dimensions."),
      limit: z.number().int().min(1).max(1000).optional().describe("Maximum rows. Default 100."),
    }),
    run: (args, ctx) => queryMetric(ctx.warehouse, args),
  }),
  tool({
    name: "compare_periods",
    description:
      "Compare one metric between two date ranges. Returns both values, the change (period_b minus period_a) and the percent change, per group if dimensions are given.",
    input: z.strictObject({
      metric,
      period_a: period.describe("The earlier or baseline period."),
      period_b: period.describe("The period to compare against the baseline."),
      dimensions: dimensions.optional(),
      filters: filters.optional(),
    }),
    run: (args, ctx) => comparePeriods(ctx.warehouse, args),
  }),
  tool({
    name: "explain_metric",
    description:
      "Return the plain-language definition of a metric and the exact SQL that query_metric would run for the given arguments.",
    input: z.strictObject({
      metric,
      start_date: date.optional(),
      end_date: date.optional(),
      dimensions: dimensions.optional(),
      filters: filters.optional(),
    }),
    run: (args, ctx) => explainMetric(ctx.warehouse, args),
  }),
  tool({
    name: "propose_budget_change",
    description:
      "Record a proposal to change a campaign budget. The proposal is stored as pending. It is not applied. A person approves or rejects it outside this server.",
    input: z.strictObject({
      campaign: z.string().describe("Exact campaign name from list_metrics."),
      change_percent: z
        .number()
        .min(-50)
        .max(50)
        .refine((n) => n !== 0, "A change of 0 percent is not a change.")
        .describe("Percent change to the budget. Negative to cut. Between -50 and 50."),
      rationale: z.string().min(20).max(1000).describe("Why, with the metric values that support it."),
    }),
    run: (args, ctx) => {
      const campaigns = knownFilterValues(ctx.warehouse).campaign;
      if (!campaigns.includes(args.campaign)) {
        throw new ToolInputError(`Unknown campaign "${args.campaign}". Known values: ${campaigns.join(", ")}.`);
      }
      return {
        proposal: createProposal(ctx.state, args),
        note: "Recorded as pending. Nothing has changed. A person must approve or reject it from the command line. No tool can do that.",
      };
    },
  }),
  tool({
    name: "list_proposals",
    description: "List budget change proposals and their status (pending, approved or rejected).",
    input: z.strictObject({ status: z.enum(["pending", "approved", "rejected"]).optional() }),
    run: (args, ctx) => ({ proposals: listProposals(ctx.state, args.status) }),
  }),
];

export function toolJsonSchema(definition: ToolDefinition): Record<string, unknown> {
  const { $schema: _dropped, ...schema } = z.toJSONSchema(definition.input) as Record<string, unknown>;
  return schema;
}

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

export function callTool(ctx: Context, name: string, rawArgs: unknown, actor = "mcp"): ToolOutcome {
  const outcome = execute(ctx, name, rawArgs);
  writeAudit(ctx.state, {
    actor,
    action: name,
    arguments: rawArgs,
    ok: outcome.ok,
    detail: outcome.ok ? undefined : outcome.error,
  });
  return outcome;
}

function execute(ctx: Context, name: string, rawArgs: unknown): ToolOutcome {
  const definition = TOOLS.find((t) => t.name === name);
  if (!definition) {
    return { ok: false, error: `Unknown tool "${name}". Tools: ${TOOLS.map((t) => t.name).join(", ")}.` };
  }
  const parsed = definition.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
    return { ok: false, error: `Invalid input. ${problems.join("; ")}` };
  }
  try {
    return { ok: true, result: definition.run(parsed.data, ctx) };
  } catch (error) {
    if (error instanceof ToolInputError) return { ok: false, error: error.message };
    throw error;
  }
}
