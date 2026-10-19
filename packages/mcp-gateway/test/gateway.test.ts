import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { generateSigningKey, parsePolicy, verifyReceiptSignature } from "@agentproof/core";
import { createVerifier, MemoryReceiptStore, type VerifierOptions } from "@agentproof/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createGateway, RECEIPT_META_KEY, type GatewayOptions, type ReceiptSummary } from "@agentproof/mcp-gateway";
import { upstreamServer } from "./fixtures/upstream.ts";

const POLICY_TEXT = readFileSync(new URL("./fixtures/gateway.yaml", import.meta.url), "utf8");
const WORKER = "agent://assistant-1";
const COORDINATOR = "gateway://operator";

/** agent ⇄ gateway ⇄ upstream, all in memory. */
async function setup(opts: { policyText?: string; verifier?: Partial<VerifierOptions>; gateway?: Partial<GatewayOptions> } = {}) {
  const store = new MemoryReceiptStore();
  let n = 0;
  const verifier = await createVerifier({
    policy: parsePolicy(opts.policyText ?? POLICY_TEXT),
    store,
    newId: () => String(++n).padStart(4, "0"),
    ...opts.verifier,
  });
  const up = upstreamServer();
  const [upClient, upServer] = InMemoryTransport.createLinkedPair();
  await up.server.connect(upServer);
  const upstream = new Client({ name: "gateway", version: "0" });
  await upstream.connect(upClient);

  const gateway = createGateway({ verifier, upstream, contract: "agent_tools", worker: WORKER, coordinator: COORDINATOR, taskPrefix: "t", ...opts.gateway });
  const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
  await gateway.connect(gatewaySide);
  const agent = new Client({ name: "agent", version: "0" });
  await agent.connect(agentSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await agent.callTool({ name, arguments: args })) as CallToolResult;
  return { agent, gateway, verifier, store, upstreamCalls: up.calls, call };
}

const summaryOf = (result: CallToolResult) => result._meta?.[RECEIPT_META_KEY] as ReceiptSummary;
const textOf = (result: CallToolResult) => (result.content[0] as { text: string }).text;

describe("MCP gateway", () => {
  test("an allowed call reaches the upstream server and carries its receipt", async () => {
    const { call, upstreamCalls, store } = await setup();
    const result = await call("docs.search", { q: "offline sync" });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), 'docs.search: {"q":"offline sync"}');
    assert.deepEqual(upstreamCalls, [{ name: "docs.search", arguments: { q: "offline sync" } }]);

    const summary = summaryOf(result);
    assert.equal(summary.decision, "allow");
    assert.equal(summary.task_id, "t/1");
    assert.equal(store.receipts.length, 1);
    const receipt = store.receipts[0]!;
    assert.equal(receipt.receipt_sha256, summary.receipt_sha256);
    assert.equal(receipt.contract?.worker, WORKER);
    assert.deepEqual(receipt.tool_events.map((e) => [e.tool, e.outcome]), [["docs.search", "invoked"]]);
  });

  test("a refused call never reaches the upstream server and gets a block receipt", async () => {
    const { call, upstreamCalls, store } = await setup();
    const result = await call("publish.post", { q: "ship it" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^AgentProof blocked 'publish\.post' \(TOOL_NOT_ALLOWED\)\. The tool was not called\./);
    assert.deepEqual(upstreamCalls, []);
    const summary = summaryOf(result);
    assert.equal(summary.decision, "block");
    assert.deepEqual(summary.reason_codes, ["TOOL_NOT_ALLOWED"]);
    assert.deepEqual(store.receipts[0]!.tool_events.map((e) => e.outcome), ["blocked"]);
  });

  test("each call is its own attempt, so a refusal does not poison later calls", async () => {
    const { call, store } = await setup();
    assert.equal((await call("publish.post")).isError, true);
    assert.equal((await call("docs.read")).isError, undefined);
    assert.deepEqual(store.receipts.map((r) => [r.task_id, r.decision]), [["t/1", "block"], ["t/2", "allow"]]);
  });

  test("concurrent calls are gated independently", async () => {
    const { call, store } = await setup();
    const results = await Promise.all([call("docs.read", { q: "a" }), call("publish.post"), call("docs.search", { q: "b" })]);
    assert.deepEqual(results.map((r) => summaryOf(r).decision), ["allow", "block", "allow"]);
    assert.equal(store.receipts.length, 3);
  });

  test("a policy that sends failures to review refuses the call pending a person", async () => {
    const { call, upstreamCalls } = await setup({ policyText: POLICY_TEXT.replace("on_required_check_fail: block", "on_required_check_fail: review") });
    const result = await call("publish.post");
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^AgentProof refused 'publish\.post' pending human review \(TOOL_NOT_ALLOWED\); a person must approve before it is retried\. The tool was not called\./);
    assert.equal(summaryOf(result).decision, "review");
    assert.deepEqual(upstreamCalls, []);
  });

  test("observe mode lets the call run but records what enforcement would have done", async () => {
    const { call, upstreamCalls } = await setup({ verifier: { mode: "observe" } });
    const result = await call("publish.post", { q: "x" });
    assert.equal(result.isError, undefined);
    assert.equal(upstreamCalls.length, 1);
    const summary = summaryOf(result);
    assert.equal(summary.decision, "allow");
    assert.equal(summary.evaluated_decision, "block");
    assert.deepEqual(summary.reason_codes, ["TOOL_NOT_ALLOWED"]);
  });

  test("a result that comes back after the contract deadline is withheld", async () => {
    let t = Date.parse("2026-10-19T10:00:00Z");
    const { gateway, upstreamCalls } = await setup({ verifier: { now: () => new Date(t) } });
    // callTool issues the contract and runs the guard synchronously, before its first await,
    // so the clock moves only after the guard passed: the upstream call "takes" 31 s, past the 30 s deadline.
    const slow = gateway.callTool("docs.read", { q: "slow" });
    t += 31_000;
    const { result, executed } = await slow;
    assert.equal(executed, true);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /CONTRACT_EXPIRED.*The tool ran, but its result is withheld\./);
  });

  test("tools/list hides refused tools in enforce mode", async () => {
    const { agent } = await setup();
    assert.deepEqual((await agent.listTools()).tools.map((t) => t.name), ["docs.search", "docs.read"]);
  });

  test("tools/list shows everything in observe mode or with listAllTools", async () => {
    const all = ["docs.search", "docs.read", "publish.post"];
    assert.deepEqual((await (await setup({ verifier: { mode: "observe" } })).agent.listTools()).tools.map((t) => t.name), all);
    assert.deepEqual((await (await setup({ gateway: { listAllTools: true } })).agent.listTools()).tools.map((t) => t.name), all);
  });

  test("resources and prompts are not served, so nothing reaches upstream around the gate", async () => {
    const { agent } = await setup();
    assert.equal(agent.getServerCapabilities()?.resources, undefined);
    assert.equal(agent.getServerCapabilities()?.prompts, undefined);
    await assert.rejects(agent.listResources(), /Method not found/);
    await assert.rejects(agent.listPrompts(), /Method not found/);
  });

  test("an upstream failure comes back as an error result with a receipt", async () => {
    const { call, store } = await setup();
    const result = await call("docs.read", { fail: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /upstream exploded/);
    assert.equal(store.receipts.length, 1);
    assert.ok(summaryOf(result).receipt_sha256);
  });

  test("receipts are signed when the verifier has a signing key", async () => {
    const keys = generateSigningKey();
    const { call, store } = await setup({ verifier: { signingKeyPem: keys.privateKeyPem } });
    await call("docs.search", { q: "x" });
    assert.equal(verifyReceiptSignature(store.receipts[0]!, keys.publicKeyPem).ok, true);
  });

  test("the receipt binds the arguments, so different arguments give different output hashes", async () => {
    const { call, store } = await setup();
    await call("docs.search", { q: "a" });
    await call("docs.search", { q: "b" });
    assert.notEqual(store.receipts[0]!.output_sha256, store.receipts[1]!.output_sha256);
  });

  test("the gateway refuses a contract the policy doesn't declare, or a worker acting as coordinator", async () => {
    await assert.rejects(setup({ gateway: { contract: "nope" } }), /declares no contract 'nope'/);
    await assert.rejects(setup({ gateway: { coordinator: WORKER } }), /must be different identities/);
  });
});

describe("MCP gateway policy checks", () => {
  test("a policy that requires claims is refused with the fix", async () => {
    await assert.rejects(setup({ policyText: POLICY_TEXT.replace("min_claims: 0", "min_claims: 1") }), /Set checks\.evidence\.min_claims: 0/);
  });

  test("a gateway contract with an output_schema is refused", async () => {
    const text = POLICY_TEXT.replace("allowed_tools: [docs.search, docs.read]", "allowed_tools: [docs.search, docs.read]\n    output_schema: {type: object}");
    await assert.rejects(setup({ policyText: text }), /declares an output_schema/);
  });
});
