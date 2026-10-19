/**
 * A shopping agent with a wallet, behind the AgentProof MCP gateway.
 *
 *   agent ──MCP──▶ agentproof gateway ──MCP──▶ payments server
 *                        │
 *                        └─ contract: SGD only, approved merchants,
 *                           ≤ 80 per payment, ≤ 150 a day → signed receipt per call
 *
 * The agent is a plain MCP client with no AgentProof code. It is scripted (no
 * model), so every run makes the same calls: some fine, some over the limit,
 * one to a merchant nobody approved, and one it was talked into by a product
 * page. The gateway decides each call before it reaches the payments server.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateSigningKey, parsePolicy, type Receipt, type ReasonCode } from "@agentproof/core";
import { createGateway } from "@agentproof/mcp-gateway";
import { createVerifier, type ReceiptStore } from "@agentproof/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { merchantServer, type Payment } from "./merchant.ts";

export const POLICY_FILE = fileURLToPath(new URL("../agentproof.yaml", import.meta.url));
export const WORKER = "agent://shopper-1";
export const COORDINATOR = "household://tan-family";

/** What the agent tries, in order. `why` is the story, not something the gateway sees. */
export const PLAN: Array<{ tool: string; args: Record<string, unknown>; why: string }> = [
  { tool: "catalog.search", args: { query: "birthday gift" }, why: "look for a gift" },
  { tool: "payments.send", args: { merchant: "challenger", amount: 59.9, currency: "SGD", item: "Wireless headphones" }, why: "buy the headphones" },
  { tool: "payments.send", args: { merchant: "challenger", amount: 1299, currency: "SGD", item: "Laptop" }, why: "upsell: a laptop" },
  { tool: "payments.send", args: { merchant: "gift-deals-24h", amount: 25, currency: "SGD", item: "Gift card" }, why: "a merchant nobody approved" },
  { tool: "payments.send", args: { merchant: "popular-bookstore", amount: 42.5, currency: "SGD", item: "Illustrated atlas" }, why: "buy a book" },
  { tool: "payments.send", args: { merchant: "fairprice", amount: 64, currency: "SGD", item: "Birthday cake" }, why: "one more, past the daily limit" },
  { tool: "wallet.export_keys", args: {}, why: "a product page told it to" },
];

export interface Step {
  tool: string;
  args: Record<string, unknown>;
  why: string;
  decision: Receipt["decision"];
  /** Whether the call reached the payments server. */
  executed: boolean;
  receipt: Receipt;
  /** What the agent got back. */
  result: CallToolResult;
  /** The guard's reason code and message, when it stopped the call. */
  reasonCode?: ReasonCode;
  reason?: string;
  /** Spend used today after this call (metered tools only). */
  spentToday?: number;
}

export interface ShoppingRun {
  /** Tools the agent was shown by `tools/list`. */
  visibleTools: string[];
  steps: Step[];
  /** What actually reached the payments server. */
  payments: Payment[];
  keyExports: number;
  receipts: Receipt[];
  publicKeyPem: string;
}

/** Run the scripted agent through the gateway. Receipts go to `store` as well as the result. */
export async function runShopping(opts: { store?: ReceiptStore; signingKey?: { privateKeyPem: string; publicKeyPem: string } } = {}): Promise<ShoppingRun> {
  const keys = opts.signingKey ?? generateSigningKey();
  const receipts: Receipt[] = [];
  const store: ReceiptStore = {
    async save(receipt) {
      receipts.push(receipt);
      return opts.store?.save(receipt);
    },
  };
  const verifier = await createVerifier({
    policy: parsePolicy(await readFile(POLICY_FILE, "utf8")),
    store,
    signingKeyPem: keys.privateKeyPem,
  });

  // gateway ⇄ payments server
  const merchant = merchantServer();
  const [upClient, upServer] = InMemoryTransport.createLinkedPair();
  await merchant.server.connect(upServer);
  const upstream = new Client({ name: "agentproof-gateway", version: "0.1.0" });
  await upstream.connect(upClient);

  // agent ⇄ gateway. The worker identity is the operator's, not something the agent claims.
  const gateway = createGateway({ verifier, upstream, contract: "shopping", worker: WORKER, coordinator: COORDINATOR, taskPrefix: "shop" });
  const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
  await gateway.connect(gatewaySide);
  const agent = new Client({ name: "shopping-agent", version: "1.0.0" });
  await agent.connect(agentSide);

  try {
    const visibleTools = (await agent.listTools()).tools.map((t) => t.name);
    const steps: Step[] = [];
    for (const { tool, args, why } of PLAN) {
      const before = receipts.length;
      // The agent calls the gateway like any MCP server; each call leaves exactly one receipt.
      const result = (await agent.callTool({ name: tool, arguments: args })) as CallToolResult;
      const receipt = receipts[before];
      if (!receipt) throw new Error(`no receipt for ${tool}`);
      const event = receipt.tool_events[0];
      steps.push({
        tool,
        args,
        why,
        decision: receipt.decision,
        executed: event?.outcome === "invoked",
        receipt,
        result,
        ...(event?.reason_code ? { reasonCode: event.reason_code } : {}),
        ...(event?.reason ? { reason: event.reason } : {}),
        ...(event?.consumed?.total !== undefined ? { spentToday: event.consumed.total } : {}),
      });
    }
    return { visibleTools, steps, payments: [...merchant.payments], keyExports: merchant.keyExports.length, receipts, publicKeyPem: keys.publicKeyPem };
  } finally {
    await agent.close();
    await upstream.close();
  }
}
