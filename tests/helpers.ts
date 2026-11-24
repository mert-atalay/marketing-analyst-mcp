import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openState, openWarehouse, type Context } from "../src/db.ts";
import { buildWarehouse } from "../src/seed.ts";
import { callTool } from "../src/tools.ts";

// Each test file builds its own warehouse in a temp folder, so tests do not depend on data/.
export function testFiles() {
  const dir = mkdtempSync(join(tmpdir(), "marketing-analyst-mcp-"));
  const warehouse = join(dir, "warehouse.db");
  buildWarehouse(warehouse);
  return { dir, warehouse, state: join(dir, "state.db") };
}

export function testContext(): Context {
  return { warehouse: openWarehouse(testFiles().warehouse), state: openState(":memory:") };
}

// Calls a tool and returns the result, failing the test if the tool rejected the call.
export function ok<T = any>(ctx: Context, name: string, args: unknown): T {
  const outcome = callTool(ctx, name, args, "test");
  if (!outcome.ok) throw new Error(`Expected ${name} to succeed: ${outcome.error}`);
  return outcome.result as T;
}

// Calls a tool and returns the error text, failing the test if the call went through.
export function rejected(ctx: Context, name: string, args: unknown): string {
  const outcome = callTool(ctx, name, args, "test");
  if (outcome.ok) throw new Error(`Expected ${name} to be rejected`);
  return outcome.error;
}
