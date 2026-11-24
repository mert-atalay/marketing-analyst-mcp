// Optional model-in-the-loop eval. Sends each question to Claude with the same tools
// the MCP server exposes, then scores tool choice and answer correctness.
// Needs ANTHROPIC_API_KEY. Costs money. Not run in CI.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { PROJECT_ROOT } from "../src/paths.ts";
import { callTool, toolJsonSchema, TOOLS } from "../src/tools.ts";
import {
  answerCorrect, evalContext, loadCases, toolChoiceCorrect, type EvalCase, type ToolCall,
} from "./lib.ts";

const MODEL = process.env.EVAL_MODEL || "claude-sonnet-5-5";
const MAX_TURNS = 8;

const SYSTEM = `You are a marketing analyst for Harbour Fitness, a fictional gym business. All data is synthetic.
Answer only from the tools. Never guess a number. Today is 2026-07-01 and the data covers 2026-01-01 to 2026-06-30.
End your reply with one line in this form: ANSWER: <value>
For a number, give only the number with no units or thousands separators. For a name, give the exact name.`;

interface ModelResult {
  id: string;
  tool_choice_correct: boolean;
  answer_correct: boolean | null; // null when the answer is not scored for this case
  tool_calls: ToolCall[];
  final_text: string;
  note?: string;
}

const tools: Anthropic.Tool[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: toolJsonSchema(t) as Anthropic.Tool.InputSchema,
}));

async function ask(client: Anthropic, c: EvalCase): Promise<ModelResult> {
  const ctx = evalContext(); // fresh in-memory state per question
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: c.question }];
  const toolCalls: ToolCall[] = [];
  let finalText = "";
  let note: string | undefined;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // No fallback model is configured on purpose: the scores should describe one model.
    const response = await client.messages.create({ model: MODEL, max_tokens: 16000, system: SYSTEM, tools, messages });
    finalText = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason !== "end_turn") note = `stopped with ${response.stop_reason}`;
      break;
    }
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const outcome = callTool(ctx, block.name, block.input, "eval:model");
      toolCalls.push({ name: block.name, input: block.input, ok: outcome.ok });
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: outcome.ok ? JSON.stringify(outcome.result) : outcome.error,
        is_error: !outcome.ok,
      });
    }
    messages.push({ role: "user", content: results });
    if (turn === MAX_TURNS - 1) note = `no final answer after ${MAX_TURNS} turns`;
  }

  return {
    id: c.id,
    tool_choice_correct: toolChoiceCorrect(c, toolCalls),
    answer_correct: c.score_answer_with_model === false ? null : answerCorrect(c, finalText),
    tool_calls: toolCalls,
    final_text: finalText,
    note,
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. The model eval is optional and needs a key.");
    console.error("Copy .env.example to .env and add a key, or run the deterministic eval with: npm run eval");
    process.exit(1);
  }
  const client = new Anthropic();
  const cases = loadCases().filter((c) => c.expect_error === undefined);
  console.log(`Model: ${MODEL}. ${cases.length} questions.\n`);

  const results: ModelResult[] = [];
  for (const c of cases) {
    const r = await ask(client, c);
    results.push(r);
    const answer = r.answer_correct === null ? "not scored" : r.answer_correct ? "correct" : "WRONG";
    console.log(`${r.id}: tool choice ${r.tool_choice_correct ? "correct" : "WRONG"}, answer ${answer}${r.note ? ` (${r.note})` : ""}`);
  }

  const scored = results.filter((r) => r.answer_correct !== null);
  console.log(`\nTool choice: ${results.filter((r) => r.tool_choice_correct).length}/${results.length}`);
  console.log(`Answers:     ${scored.filter((r) => r.answer_correct).length}/${scored.length}`);

  const dir = join(PROJECT_ROOT, "evals", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ model: MODEL, results }, null, 2));
  console.log(`Details written to ${file}`);
}

try {
  await main();
} catch (error) {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error("The API key was rejected. Check ANTHROPIC_API_KEY.");
  } else if (error instanceof Anthropic.RateLimitError) {
    console.error("Rate limited. Try again later.");
  } else if (error instanceof Anthropic.APIError) {
    console.error(`API error ${error.status}: ${error.message}`);
  } else {
    throw error;
  }
  process.exit(1);
}
