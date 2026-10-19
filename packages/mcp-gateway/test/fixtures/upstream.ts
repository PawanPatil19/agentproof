/**
 * A small upstream MCP server for tests. Records every call it receives so
 * tests can prove a refused call never reached it.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const TOOLS = ["docs.search", "docs.read", "publish.post"] as const;

export function upstreamServer() {
  const calls: { name: string; arguments: unknown }[] = [];
  const server = new Server({ name: "upstream", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: "object" as const, properties: { q: { type: "string" } } } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push({ name: request.params.name, arguments: request.params.arguments });
    if (request.params.arguments?.fail) throw new Error("upstream exploded");
    return { content: [{ type: "text" as const, text: `${request.params.name}: ${JSON.stringify(request.params.arguments ?? {})}` }] };
  });
  return { server, calls };
}

// Run as a stdio server when executed directly (used by the CLI end-to-end test).
if (import.meta.url === `file://${process.argv[1]}`) {
  await upstreamServer().server.connect(new StdioServerTransport());
}
