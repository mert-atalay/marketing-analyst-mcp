// The human side of the approval step.
//   npm run proposals
//   npm run approve -- <id> [note]
//   npm run reject -- <id> [note]
// It asks for confirmation on an interactive terminal and refuses to run without one.
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { decideProposal } from "../approval.ts";
import { openState } from "../db.ts";
import { getProposal, listProposals } from "../proposals.ts";

const [command, idArg, ...noteParts] = process.argv.slice(2);
const state = openState();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (command === "list") {
  const proposals = listProposals(state);
  if (!proposals.length) console.log("No proposals yet.");
  for (const p of proposals) {
    console.log(`#${p.id} [${p.status}] ${p.campaign} ${p.change_percent > 0 ? "+" : ""}${p.change_percent}%`);
    console.log(`   ${p.rationale}`);
  }
  process.exit(0);
}

if (command !== "approve" && command !== "reject") {
  fail("Usage: npm run approve -- <id> [note] | npm run reject -- <id> [note] | npm run proposals");
}
const id = Number(idArg);
if (!Number.isInteger(id) || id < 1) fail("Give the proposal id as a whole number.");

const proposal = getProposal(state, id);
if (!proposal) fail(`Proposal ${id} does not exist.`);
if (proposal.status !== "pending") fail(`Proposal ${id} is already ${proposal.status}.`);

console.log(`Proposal #${proposal.id}, created ${proposal.created_at}`);
console.log(`Campaign:  ${proposal.campaign}`);
console.log(`Change:    ${proposal.change_percent > 0 ? "+" : ""}${proposal.change_percent}% budget`);
console.log(`Rationale: ${proposal.rationale}`);

if (!process.stdin.isTTY) {
  fail("\nRefusing to decide without an interactive terminal. A person has to confirm this.");
}
const prompt = createInterface({ input: process.stdin, output: process.stdout });
// Ctrl+C or Ctrl+D at the prompt counts as "no".
const answer = await prompt.question(`\nType "${command} ${id}" to confirm: `).catch(() => "");
prompt.close();
if (answer.trim() !== `${command} ${id}`) fail("Not confirmed. Nothing changed.");

const decided = decideProposal(state, {
  id,
  decision: command === "approve" ? "approved" : "rejected",
  decidedBy: userInfo().username,
  note: noteParts.join(" ") || undefined,
});
console.log(`Proposal #${decided.id} is now ${decided.status}.`);
console.log("This example only records the decision. It is not connected to any ad platform.");
