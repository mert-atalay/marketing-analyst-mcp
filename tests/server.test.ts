// Starts the real server as a child process and talks to it over stdio with the MCP client.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PROJECT_ROOT } from "../src/paths.ts";
import { testFiles } from "./helpers.ts";

const files = testFiles();
const client = new Client({ name: "test-client", version: "0.0.0" });

before(async () => {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(PROJECT_ROOT, "src", "server.ts")],
      env: { ...(process.env as Record<string, string>), WAREHOUSE_DB: files.warehouse, STATE_DB: files.state },
      stderr: "ignore",
    }),
  );
});

after(() => client.close());

function text(result: Awaited<ReturnType<typeof client.callTool>>): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

test("the server lists six tools with object schemas", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description);
  }
});

test("query_metric works over stdio", async () => {
  const result = await client.callTool({
    name: "query_metric",
    arguments: { metric: "leads", start_date: "2026-03-01", end_date: "2026-03-31" },
  });
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(text(result)).rows[0].value, 2777);
});

test("a rejected call comes back as a tool error, not a crash", async () => {
  const result = await client.callTool({
    name: "query_metric",
    arguments: { metric: "roas", start_date: "2026-03-01", end_date: "2026-03-31" },
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /Invalid option/);
  const again = await client.callTool({ name: "list_proposals", arguments: {} });
  assert.deepEqual(JSON.parse(text(again)), { proposals: [] });
});
