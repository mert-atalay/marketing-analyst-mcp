// The metric registry. This file is the only place where metric SQL is written.
// Tools pick expressions from here by name. They never accept SQL from the caller.

// Each fact source exposes the same columns so the sources can be stacked with UNION ALL.
export const FACT_SOURCES = {
  spend: `SELECT s.date AS date, c.channel AS channel, c.name AS campaign, l.name AS location,
         s.spend_cents AS spend_cents, 0 AS leads, 0 AS trials, 0 AS members
    FROM ad_spend s
    JOIN campaigns c ON c.campaign_id = s.campaign_id
    JOIN locations l ON l.location_id = s.location_id`,
  leads: `SELECT d.created_date AS date, c.channel AS channel, c.name AS campaign, l.name AS location,
         0 AS spend_cents, 1 AS leads, d.trial_date IS NOT NULL AS trials, d.member_date IS NOT NULL AS members
    FROM leads d
    JOIN campaigns c ON c.campaign_id = d.campaign_id
    JOIN locations l ON l.location_id = d.location_id`,
} as const;

export type FactSource = keyof typeof FACT_SOURCES;

export const DIMENSIONS = {
  day: { sql: "date", description: "Calendar day (YYYY-MM-DD)." },
  week: { sql: "date(date, 'weekday 0', '-6 days')", description: "Week, labelled by its Monday." },
  month: { sql: "strftime('%Y-%m', date)", description: "Calendar month (YYYY-MM)." },
  channel: { sql: "channel", description: "Ad platform: google or meta." },
  campaign: { sql: "campaign", description: "Campaign name." },
  location: { sql: "location", description: "Gym location name." },
} as const;

export type Dimension = keyof typeof DIMENSIONS;
export const DIMENSION_NAMES = Object.keys(DIMENSIONS) as Dimension[];
export const DATE_GRAINS: Dimension[] = ["day", "week", "month"];
// Dimensions that can also be used as filters.
export const FILTER_NAMES = ["channel", "campaign", "location"] as const;
export type FilterName = (typeof FILTER_NAMES)[number];

export interface Metric {
  label: string;
  definition: string;
  unit: "usd" | "count" | "ratio";
  sql: string;
  sources: FactSource[];
  dimensions: Dimension[];
}

const ALL = DIMENSION_NAMES;
// Member based ratios are too noisy on a single day, so the day grain is not offered.
const NO_DAY = ALL.filter((d) => d !== "day");

const COHORT =
  "counted by the date the lead was created (cohort view), not by the date the event happened";

export const METRICS = {
  spend: {
    label: "Ad spend",
    definition: "Total ad spend in dollars on Google and Meta, by the day the spend happened.",
    unit: "usd",
    sql: "ROUND(SUM(spend_cents) / 100.0, 2)",
    sources: ["spend"],
    dimensions: ALL,
  },
  leads: {
    label: "Leads",
    definition: "Number of leads, by the date the lead was created.",
    unit: "count",
    sql: "SUM(leads)",
    sources: ["leads"],
    dimensions: ALL,
  },
  cost_per_lead: {
    label: "Cost per lead",
    definition: "Ad spend divided by leads for the same period and slice. Null when there are no leads.",
    unit: "usd",
    sql: "ROUND(SUM(spend_cents) / 100.0 / NULLIF(SUM(leads), 0), 2)",
    sources: ["spend", "leads"],
    dimensions: ALL,
  },
  trials: {
    label: "Trials",
    definition: `Number of leads that started a free trial, ${COHORT}.`,
    unit: "count",
    sql: "SUM(trials)",
    sources: ["leads"],
    dimensions: ALL,
  },
  members: {
    label: "Members",
    definition: `Number of leads that became paying members, ${COHORT}.`,
    unit: "count",
    sql: "SUM(members)",
    sources: ["leads"],
    dimensions: ALL,
  },
  cost_per_member: {
    label: "Cost per member",
    definition: `Ad spend divided by members. Members are ${COHORT}. Null when there are no members. Recent periods look worse than they are because some leads have not converted yet.`,
    unit: "usd",
    sql: "ROUND(SUM(spend_cents) / 100.0 / NULLIF(SUM(members), 0), 2)",
    sources: ["spend", "leads"],
    dimensions: NO_DAY,
  },
  lead_to_member_rate: {
    label: "Lead to member rate",
    definition: `Members divided by leads, as a fraction between 0 and 1. Members are ${COHORT}. Recent periods look lower than they are because some leads have not converted yet.`,
    unit: "ratio",
    sql: "ROUND(1.0 * SUM(members) / NULLIF(SUM(leads), 0), 4)",
    sources: ["leads"],
    dimensions: NO_DAY,
  },
} as const satisfies Record<string, Metric>;

export type MetricName = keyof typeof METRICS;
export const METRIC_NAMES = Object.keys(METRICS) as MetricName[];
