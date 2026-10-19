/**
 * @agentproof/mcp-gateway — put AgentProof in front of any MCP server.
 *
 *   const upstream = new Client({ name: "gateway", version: "0.1.0" });
 *   await upstream.connect(new StdioClientTransport({ command: "my-mcp-server" }));
 *   const verifier = await createVerifier({ policyFile: "./agentproof.yaml" });
 *   const gateway = createGateway({ verifier, upstream, contract: "agent_tools", worker, coordinator });
 *   await gateway.connect(new StdioServerTransport());
 */
export { createGateway, Gateway, RECEIPT_META_KEY, summarize, type GatewayCall, type GatewayOptions, type ReceiptSummary } from "./gateway.ts";
export { parseGatewayArgs, runGateway, GATEWAY_HELP, GatewayUsageError, type GatewayConfig } from "./run.ts";
export { GATEWAY_VERSION } from "./version.ts";
