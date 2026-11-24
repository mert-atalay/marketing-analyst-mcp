// Deciding a proposal. Only the CLI in src/cli/decide.ts imports this file.
// A test checks that the tool layer and the server do not.
import type { DatabaseSync } from "node:sqlite";
import { writeAudit } from "./db.ts";
import { getProposal, type Proposal } from "./proposals.ts";

export function decideProposal(
  state: DatabaseSync,
  input: { id: number; decision: "approved" | "rejected"; decidedBy: string; note?: string },
): Proposal {
  const proposal = getProposal(state, input.id);
  if (!proposal) throw new Error(`Proposal ${input.id} does not exist.`);
  if (proposal.status !== "pending") {
    throw new Error(`Proposal ${input.id} is already ${proposal.status}.`);
  }
  state
    .prepare(
      "UPDATE proposals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ? AND status = 'pending'",
    )
    .run(input.decision, new Date().toISOString(), input.decidedBy, input.note ?? null, input.id);
  writeAudit(state, {
    actor: `cli:${input.decidedBy}`,
    action: input.decision === "approved" ? "approve_proposal" : "reject_proposal",
    arguments: { id: input.id, note: input.note ?? null },
    ok: true,
  });
  return getProposal(state, input.id)!;
}
