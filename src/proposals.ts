// The tool-facing side of budget proposals: create and read.
// Deciding a proposal lives in a separate module that the tools and the server never import.
import type { DatabaseSync } from "node:sqlite";

export interface Proposal {
  id: number;
  created_at: string;
  campaign: string;
  change_percent: number;
  rationale: string;
  status: "pending" | "approved" | "rejected";
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
}

export function createProposal(
  state: DatabaseSync,
  input: { campaign: string; change_percent: number; rationale: string },
): Proposal {
  const result = state
    .prepare("INSERT INTO proposals (created_at, campaign, change_percent, rationale) VALUES (?, ?, ?, ?)")
    .run(new Date().toISOString(), input.campaign, input.change_percent, input.rationale);
  return getProposal(state, Number(result.lastInsertRowid))!;
}

export function getProposal(state: DatabaseSync, id: number): Proposal | undefined {
  return state.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Proposal | undefined;
}

export function listProposals(state: DatabaseSync, status?: Proposal["status"]): Proposal[] {
  const rows = status
    ? state.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY id").all(status)
    : state.prepare("SELECT * FROM proposals ORDER BY id").all();
  return rows as unknown as Proposal[];
}
