// Builds the synthetic warehouse for the fictional business "Harbour Fitness".
// Every number comes from a seeded random generator, so the same seed always
// produces the same database. Nothing here is real data.
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SEED = 20260101;
export const DATA_START = "2026-01-01";
export const DATA_END = "2026-06-30";

const LOCATIONS = [
  "Downtown", "Riverside", "Northgate", "Eastside", "Westbrook", "Lakeshore",
  "Midtown", "Southport", "Hillcrest", "Bayview", "Oakridge", "Kingsway",
];

interface CampaignSpec {
  name: string;
  channel: "google" | "meta";
  dailySpend: number; // average dollars per location per day
  costPerLead: number; // average dollars
  trialRate: number; // share of leads that start a trial
  memberRate: number; // share of trials that become members
  lastDay?: string; // campaign stops after this date
}

const CAMPAIGNS: CampaignSpec[] = [
  { name: "Google Brand Search", channel: "google", dailySpend: 18, costPerLead: 14, trialRate: 0.55, memberRate: 0.5 },
  { name: "Google Local Search", channel: "google", dailySpend: 42, costPerLead: 27, trialRate: 0.45, memberRate: 0.42 },
  { name: "Google Performance Max", channel: "google", dailySpend: 35, costPerLead: 33, trialRate: 0.35, memberRate: 0.35 },
  { name: "Meta Free Trial Offer", channel: "meta", dailySpend: 48, costPerLead: 19, trialRate: 0.4, memberRate: 0.3 },
  { name: "Meta New Year Reset", channel: "meta", dailySpend: 60, costPerLead: 16, trialRate: 0.38, memberRate: 0.26, lastDay: "2026-02-28" },
  { name: "Meta Retargeting", channel: "meta", dailySpend: 15, costPerLead: 22, trialRate: 0.5, memberRate: 0.45 },
];

// Small deterministic generator (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const SCHEMA = `
CREATE TABLE locations (
  location_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE campaigns (
  campaign_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('google', 'meta'))
);
CREATE TABLE ad_spend (
  date TEXT NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns,
  location_id INTEGER NOT NULL REFERENCES locations,
  spend_cents INTEGER NOT NULL,
  PRIMARY KEY (date, campaign_id, location_id)
);
CREATE TABLE leads (
  lead_id INTEGER PRIMARY KEY,
  created_date TEXT NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns,
  location_id INTEGER NOT NULL REFERENCES locations,
  trial_date TEXT,
  member_date TEXT
);
CREATE INDEX leads_created ON leads (created_date);
`;

export interface SeedSummary {
  path: string;
  locations: number;
  campaigns: number;
  spendRows: number;
  leads: number;
}

export function buildWarehouse(path: string): SeedSummary {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const random = rng(SEED);

  const insertLocation = db.prepare("INSERT INTO locations (location_id, name) VALUES (?, ?)");
  const insertCampaign = db.prepare("INSERT INTO campaigns (campaign_id, name, channel) VALUES (?, ?, ?)");
  const insertSpend = db.prepare("INSERT INTO ad_spend (date, campaign_id, location_id, spend_cents) VALUES (?, ?, ?, ?)");
  const insertLead = db.prepare(
    "INSERT INTO leads (lead_id, created_date, campaign_id, location_id, trial_date, member_date) VALUES (?, ?, ?, ?, ?, ?)",
  );

  db.exec("BEGIN");
  // Each location gets a fixed size factor and a fixed conversion factor.
  const locationFactors = LOCATIONS.map((name, i) => {
    insertLocation.run(i + 1, name);
    return { size: 0.7 + random() * 0.7, conversion: 0.85 + random() * 0.3 };
  });
  CAMPAIGNS.forEach((c, i) => insertCampaign.run(i + 1, c.name, c.channel));

  let spendRows = 0;
  let leadId = 0;
  for (let date = DATA_START; date <= DATA_END; date = addDays(date, 1)) {
    const january = date < "2026-02-01" ? 1.25 : 1; // new year demand
    CAMPAIGNS.forEach((campaign, ci) => {
      if (campaign.lastDay && date > campaign.lastDay) return;
      locationFactors.forEach((factor, li) => {
        const spend = campaign.dailySpend * factor.size * january * (0.8 + random() * 0.4);
        const spendCents = Math.round(spend * 100);
        insertSpend.run(date, ci + 1, li + 1, spendCents);
        spendRows++;

        const expectedLeads = (spend / campaign.costPerLead) * (0.7 + random() * 0.6);
        const leadCount = Math.floor(expectedLeads) + (random() < expectedLeads % 1 ? 1 : 0);
        for (let n = 0; n < leadCount; n++) {
          let trialDate: string | null = null;
          let memberDate: string | null = null;
          if (random() < campaign.trialRate * factor.conversion) {
            trialDate = addDays(date, Math.floor(random() * 8));
            if (random() < campaign.memberRate) {
              memberDate = addDays(trialDate, 1 + Math.floor(random() * 14));
            }
          }
          // The warehouse is a snapshot taken at DATA_END. Later events are not known yet.
          if (trialDate && trialDate > DATA_END) trialDate = null;
          if (memberDate && (memberDate > DATA_END || !trialDate)) memberDate = null;
          insertLead.run(++leadId, date, ci + 1, li + 1, trialDate, memberDate);
        }
      });
    });
  }
  db.exec("COMMIT");
  db.close();
  return { path, locations: LOCATIONS.length, campaigns: CAMPAIGNS.length, spendRows, leads: leadId };
}
