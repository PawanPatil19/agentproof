import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseGatewayArgs } from "@agentproof/mcp-gateway";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const NODE = [process.execPath, "--experimental-strip-types", "--no-warnings", "--conditions=source"];

describe("gateway arguments", () => {
  test("own flags before --, the upstream command after", () => {
    const config = parseGatewayArgs(["--policy", "p.yaml", "--contract=c", "--worker", "agent://a", "--list-all-tools", "--", "srv", "--port", "1"]);
    assert.deepEqual(config, {
      policyFile: "p.yaml",
      contract: "c",
      worker: "agent://a",
      coordinator: "gateway://agentproof",
      listAllTools: true,
      command: "srv",
      args: ["--port", "1"],
    });
  });

  test("missing, unknown and malformed flags are errors", () => {
    assert.throws(() => parseGatewayArgs(["--contract", "c", "--worker", "w", "--", "srv"]), /--policy is required/);
    assert.throws(() => parseGatewayArgs(["--policy", "p", "--contract", "c", "--worker", "w"]), /no upstream server command/);
    assert.throws(() => parseGatewayArgs(["--policy", "p", "--contract", "c", "--worker", "w", "--bogus", "--", "s"]), /unknown option --bogus/);
    assert.throws(() => parseGatewayArgs(["--policy", "p", "--contract", "c", "--worker", "w", "--mode", "loud", "--", "s"]), /--mode must be/);
    assert.throws(() => parseGatewayArgs(["--policy", "--contract", "c"]), /--policy needs a value/);
  });
});

describe("gateway over stdio", () => {
  test("an unmodified MCP client is gated end to end, and receipts land on disk", async () => {
    const receipts = mkdtempSync(join(tmpdir(), "agentproof-gw-"));
    const [command, ...nodeArgs] = NODE as [string, ...string[]];
    const transport = new StdioClientTransport({
      command,
      args: [
        ...nodeArgs,
        here("../src/cli.ts"),
        "--policy", here("./fixtures/gateway.yaml"),
        "--contract", "agent_tools",
        "--worker", "agent://assistant-1",
        "--receipts", receipts,
        "--",
        ...NODE,
        here("./fixtures/upstream.ts"),
      ],
      stderr: "pipe",
    });
    const agent = new Client({ name: "agent", version: "0" });
    await agent.connect(transport);
    try {
      assert.deepEqual((await agent.listTools()).tools.map((t) => t.name), ["docs.search", "docs.read"]);
      const ok = (await agent.callTool({ name: "docs.read", arguments: { q: "x" } })) as CallToolResult;
      assert.equal(ok.isError, undefined);
      const refused = (await agent.callTool({ name: "publish.post", arguments: {} })) as CallToolResult;
      assert.equal(refused.isError, true);
    } finally {
      await agent.close();
    }
    const written = readdirSync(receipts).filter((f) => f !== "latest.json");
    assert.equal(written.length, 2);
    const decisions = written.map((f) => JSON.parse(readFileSync(join(receipts, f), "utf8")).decision).sort();
    assert.deepEqual(decisions, ["allow", "block"]);
  });
});
