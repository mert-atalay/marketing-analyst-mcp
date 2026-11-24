// Turns a validated metric request into one parameterised SQL statement.
// SQL fragments come only from the registry. Caller values are always bound as parameters.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  DATE_GRAINS, DIMENSIONS, FACT_SOURCES, FILTER_NAMES, METRICS,
  type Dimension, type FilterName, type MetricName,
} from "./registry.ts";

export class ToolInputError extends Error {}

export type Filters = Partial<Record<FilterName, string[]>>;
export type Sort = "dimensions" | "value_desc" | "value_asc";

export interface MetricQuery {
  metric: MetricName;
  start_date: string;
  end_date: string;
  dimensions?: Dimension[];
  filters?: Filters;
  sort?: Sort;
  limit?: number;
}

export interface Period {
  start_date: string;
  end_date: string;
}

export type Row = Record<string, string | number | null>;

export function knownFilterValues(db: DatabaseSync): Record<FilterName, string[]> {
  const column = (sql: string) => db.prepare(sql).all().map((r) => String(r.v));
  return {
    channel: column("SELECT DISTINCT channel AS v FROM campaigns ORDER BY 1"),
    campaign: column("SELECT name AS v FROM campaigns ORDER BY 1"),
    location: column("SELECT name AS v FROM locations ORDER BY 1"),
  };
}

export function dataCoverage(db: DatabaseSync): Period {
  const row = db.prepare("SELECT MIN(date) AS start_date, MAX(date) AS end_date FROM ad_spend").get();
  return { start_date: String(row?.start_date), end_date: String(row?.end_date) };
}

function checkDates(period: Period): void {
  for (const value of [period.start_date, period.end_date]) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new ToolInputError(`"${value}" is not a real calendar date. Use YYYY-MM-DD.`);
    }
  }
  if (period.start_date > period.end_date) {
    throw new ToolInputError(`start_date ${period.start_date} is after end_date ${period.end_date}.`);
  }
}

function checkRequest(db: DatabaseSync, q: MetricQuery): void {
  checkDates(q);
  const metric = METRICS[q.metric];
  const dimensions = q.dimensions ?? [];
  if (new Set(dimensions).size !== dimensions.length) {
    throw new ToolInputError("Each dimension can be used only once.");
  }
  if (dimensions.filter((d) => DATE_GRAINS.includes(d)).length > 1) {
    throw new ToolInputError("Use at most one date grain: day, week or month.");
  }
  const allowed: readonly Dimension[] = metric.dimensions;
  for (const d of dimensions) {
    if (!allowed.includes(d)) {
      throw new ToolInputError(
        `Dimension "${d}" is not allowed for metric "${q.metric}". Allowed: ${allowed.join(", ")}.`,
      );
    }
  }
  const known = knownFilterValues(db);
  for (const name of FILTER_NAMES) {
    for (const value of q.filters?.[name] ?? []) {
      if (!known[name].includes(value)) {
        throw new ToolInputError(
          `Unknown ${name} "${value}". Known values: ${known[name].join(", ")}.`,
        );
      }
    }
  }
}

export function buildQuery(q: MetricQuery): { sql: string; params: SQLInputValue[] } {
  const metric = METRICS[q.metric];
  const dimensions = q.dimensions ?? [];
  const facts = metric.sources.map((s) => FACT_SOURCES[s]).join("\n    UNION ALL\n    ");
  const select = [...dimensions.map((d) => `${DIMENSIONS[d].sql} AS ${d}`), `${metric.sql} AS value`];

  const where = ["date BETWEEN ? AND ?"];
  const params: SQLInputValue[] = [q.start_date, q.end_date];
  for (const name of FILTER_NAMES) {
    const values = q.filters?.[name];
    if (!values?.length) continue;
    where.push(`${name} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }

  const byDimensions = dimensions.map((_, i) => String(i + 1)).join(", ");
  const order =
    q.sort === "value_desc" ? "value DESC NULLS LAST"
    : q.sort === "value_asc" ? "value ASC NULLS LAST"
    : byDimensions;

  let sql = `WITH facts AS (\n    ${facts}\n)\nSELECT ${select.join(", ")}\nFROM facts\nWHERE ${where.join(" AND ")}`;
  if (dimensions.length) sql += `\nGROUP BY ${byDimensions}`;
  if (order) sql += `\nORDER BY ${order}`;
  sql += "\nLIMIT ?";
  params.push((q.limit ?? 100) + 1); // one extra row tells us if the result was cut off
  return { sql, params };
}

export function queryMetric(db: DatabaseSync, q: MetricQuery) {
  checkRequest(db, q);
  const { sql, params } = buildQuery(q);
  const limit = q.limit ?? 100;
  const all = db.prepare(sql).all(...params) as Row[];
  const rows = all.slice(0, limit);
  return {
    metric: q.metric,
    unit: METRICS[q.metric].unit,
    start_date: q.start_date,
    end_date: q.end_date,
    dimensions: q.dimensions ?? [],
    filters: q.filters ?? {},
    row_count: rows.length,
    truncated: all.length > limit,
    rows,
  };
}

export interface CompareInput {
  metric: MetricName;
  period_a: Period;
  period_b: Period;
  dimensions?: Dimension[];
  filters?: Filters;
}

export function comparePeriods(db: DatabaseSync, input: CompareInput) {
  const dimensions = input.dimensions ?? [];
  if (dimensions.some((d) => DATE_GRAINS.includes(d))) {
    throw new ToolInputError("compare_periods does not take a date grain. The two periods are the time split.");
  }
  const run = (period: Period) =>
    queryMetric(db, { metric: input.metric, ...period, dimensions, filters: input.filters, limit: 1000 }).rows;
  const keyOf = (row: Row) => dimensions.map((d) => row[d]).join("|");
  const a = new Map(run(input.period_a).map((r) => [keyOf(r), r]));
  const b = new Map(run(input.period_b).map((r) => [keyOf(r), r]));
  const digits = METRICS[input.metric].unit === "ratio" ? 4 : 2;
  const round = (n: number, d: number) => Number(n.toFixed(d));

  const rows = [...new Set([...a.keys(), ...b.keys()])].sort().map((key) => {
    const source = (a.get(key) ?? b.get(key))!;
    const valueA = (a.get(key)?.value ?? null) as number | null;
    const valueB = (b.get(key)?.value ?? null) as number | null;
    const both = valueA !== null && valueB !== null;
    return {
      ...Object.fromEntries(dimensions.map((d) => [d, source[d] ?? null])),
      period_a: valueA,
      period_b: valueB,
      change: both ? round(valueB - valueA, digits) : null,
      pct_change: both && valueA !== 0 ? round((valueB - valueA) / valueA, 4) : null,
    };
  });
  return {
    metric: input.metric,
    unit: METRICS[input.metric].unit,
    period_a: input.period_a,
    period_b: input.period_b,
    dimensions,
    filters: input.filters ?? {},
    note: "change is period_b minus period_a. pct_change is change divided by period_a, as a fraction.",
    rows,
  };
}

export function explainMetric(db: DatabaseSync, input: Partial<MetricQuery> & { metric: MetricName }) {
  const metric = METRICS[input.metric];
  const coverage = dataCoverage(db);
  const q: MetricQuery = {
    ...input,
    metric: input.metric,
    start_date: input.start_date ?? coverage.start_date,
    end_date: input.end_date ?? coverage.end_date,
  };
  checkRequest(db, q);
  const { sql, params } = buildQuery(q);
  return {
    metric: input.metric,
    label: metric.label,
    definition: metric.definition,
    unit: metric.unit,
    allowed_dimensions: metric.dimensions,
    sql,
    params,
    note: "This is the exact statement query_metric runs for these arguments. The ? marks are bound to params in order.",
  };
}
