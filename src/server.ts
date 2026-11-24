#!/usr/bin/env node
// MCP server over stdio. stdout carries the protocol, so logs go to stderr.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openContext } from "./db.ts";
import { callTool, toolJsonSchema, TOOLS } from "./tools.ts";

const ctx = openContext();

// The low-level Server class is used on purpose. It lets callTool validate every
// request itself, so rejected calls land in the audit log too.
const server = new Server(
  { name: "marketing-analyst-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Marketing performance data for Harbour Fitness, a fictional business. All data is synthetic. Call list_metrics first. Budget proposals are only recorded. A person approves them outside this server.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t) })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const outcome = callTool(ctx, request.params.name, request.params.arguments);
  return outcome.ok
    ? { content: [{ type: "text", text: JSON.stringify(outcome.result, null, 2) }] }
    : { content: [{ type: "text", text: outcome.error }], isError: true };
});

await server.connect(new StdioServerTransport());
console.error("marketing-analyst-mcp is running on stdio");
