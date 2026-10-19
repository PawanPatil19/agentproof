// The critique's Phase A exit gate: an agent tries to overpay, pay a stranger,
// and pay twice after a restart. All three are blocked, with receipts that say why.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parsePolicy, type Mode } from "@agentproof/core";
import { createVerifier, FileStateStore, MemoryStateStore, ToolBlockedError, type StateStore } from "@agentproof/sdk";
import { clock } from "./helpers.ts";

const PAYER = "agent://payer-1";
const BOSS = "agent://treasury-1";

const policyText = (maxTotal = 200, extra = "") => `
api_version: agentproof/v1
policy: { id: invoices, version: 1 }
mode: enforce
checks: { evidence: { min_claims: 0 } }
contracts:
  pay_invoice:
    version: 1
    coordinator: treasury
    worker: payer
    deadline_ms: 3600000
    allowed_tools: [payments.send, invoices.read]
    tool_constraints:
      payments.send:
        args_schema:
          type: object
          required: [amount, currency, to]
          properties: { amount: { type: number }, currency: { type: string }, to: { type: string } }
        allowed_values: { currency: [SGD, USDC], to: [merchant-a, merchant-b] }
        amount_field: amount
        max_per_call: 50
        max_total: ${maxTotal}
        max_calls: 5
${extra}
    output_schema: { type: object }
enforcement:
  max_repair_attempts: 2
`;

async function setup(opts: { state?: StateStore; mode?: Mode; now?: () => Date; policy?: string } = {}) {
  let n = 0;
  const proof = await createVerifier({
    policy: parsePolicy(opts.policy ?? policyText()),
    store: false,
    mode: opts.mode,
    now: opts.now,
    state: opts.state,
    newId: () => `${Date.now().toString(36)}${++n}`,
  });
  const paid: unknown[] = [];
  const pay = (contract: Parameters<typeof proof.guardTools>[1]) => proof.guardTools(async (_tool, args) => void paid.push(args), contract, { identity: PAYER });
  return { proof, paid, pay };
}

const send = (amount: number, to = "merchant-a", currency = "SGD") => ({ amount, currency, to });
const reasonOf = (e: unknown) => (e as ToolBlockedError).reason;

describe("mandates: argument constraints in the tool guard", () => {
  it("blocks overpaying, paying a stranger and a wrong currency before the tool runs", async () => {
    const { proof, paid, pay } = await setup();
    const contract = proof.acceptContract(proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    const tools = pay(contract);

    await tools("payments.send", send(40));
    await assert.rejects(tools("payments.send", send(60)), (e) => reasonOf(e) === "TOOL_LIMIT_EXCEEDED");
    await assert.rejects(tools("payments.send", send(10, "stranger")), (e) => reasonOf(e) === "TOOL_ARGS_INVALID");
    await assert.rejects(tools("payments.send", send(10, "merchant-a", "BTC")), (e) => reasonOf(e) === "TOOL_ARGS_INVALID");
    await assert.rejects(tools("payments.send", { amount: 10 }), (e) => reasonOf(e) === "TOOL_ARGS_INVALID");
    await tools("invoices.read", { id: "anything" }); // unconstrained tool
    assert.deepEqual(paid, [send(40), { id: "anything" }]);

    const receipt = await proof.verifyCompletion({ contract, output: { paid: 40 }, identity: PAYER });
    assert.equal(receipt.decision, "block");
    // tools.permission reports the first violation per tool; every event keeps its own reason.
    assert.deepEqual(receipt.reason_codes, ["TOOL_LIMIT_EXCEEDED"]);
    assert.deepEqual(receipt.tool_events.map((e) => e.reason_code ?? "OK"), ["OK", "TOOL_LIMIT_EXCEEDED", "TOOL_ARGS_INVALID", "TOOL_ARGS_INVALID", "TOOL_ARGS_INVALID", "OK"]);
    const sends = receipt.tool_events.filter((e) => e.tool === "payments.send");
    assert.equal(sends[0]?.outcome, "invoked");
    assert.equal(sends[0]?.amount, 40);
    assert.deepEqual(sends[0]?.consumed, { calls: 1, total: 40 });
    assert.deepEqual(sends[1]?.consumed, { calls: 1, total: 40 }, "a blocked call records usage so far, not its own amount");
    assert.equal(sends[1]?.amount, 60);
  });

  it("a clean run within limits is allowed and the receipt shows authority used", async () => {
    const { proof, pay } = await setup();
    const contract = proof.acceptContract(proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    const tools = pay(contract);
    await tools("payments.send", send(50));
    await tools("payments.send", send(25.5, "merchant-b", "USDC"));
    const receipt = await proof.verifyCompletion({ contract, output: {}, identity: PAYER });
    assert.equal(receipt.decision, "allow");
    assert.deepEqual(receipt.tool_events.at(-1)?.consumed, { calls: 2, total: 75.5 });
  });

  it("max_total spans retries, so failing an attempt does not refill the budget", async () => {
    const { proof, paid, pay } = await setup({ policy: policyText(100) });
    const first = proof.acceptContract(proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    await pay(first)("payments.send", send(50));
    await pay(first)("payments.send", send(50));
    await proof.verifyCompletion({ contract: first, output: "not an object", identity: PAYER });
    const second = proof.acceptContract(proof.retry(first), { identity: PAYER });
    await assert.rejects(pay(second)("payments.send", send(1)), (e) => reasonOf(e) === "TOOL_LIMIT_EXCEEDED");
    assert.equal(paid.length, 2);
    // A different task has its own budget.
    const other = proof.acceptContract(proof.issueContract("pay_invoice", { taskId: "inv-2", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    await pay(other)("payments.send", send(50));
    assert.equal(paid.length, 3);
  });

  it("window_ms makes max_total a rolling limit", async () => {
    const time = clock();
    const policy = policyText(100).replace("max_calls: 5", "max_calls: 5\n        window_ms: 600000");
    const { proof, paid, pay } = await setup({ policy, now: time.now });
    const contract = proof.acceptContract(proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    const tools = pay(contract);
    await tools("payments.send", send(50));
    await tools("payments.send", send(50));
    await assert.rejects(tools("payments.send", send(10)), (e) => reasonOf(e) === "TOOL_LIMIT_EXCEEDED");
    time.advance(600_001);
    await tools("payments.send", send(50));
    assert.equal(paid.length, 3);
  });

  it("observe mode lets a violating call run, records it, and counts it toward the budget", async () => {
    const { proof, paid, pay } = await setup({ mode: "observe", policy: policyText(100) });
    const contract = proof.acceptContract(proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    const tools = pay(contract);
    await tools("payments.send", send(80)); // over max_per_call
    await tools("payments.send", send(30)); // now over max_total too
    assert.equal(paid.length, 2);
    const receipt = await proof.verifyCompletion({ contract, output: {}, identity: PAYER });
    assert.equal(receipt.decision, "allow");
    assert.equal(receipt.evaluated_decision, "block");
    assert.deepEqual(receipt.tool_events.map((e) => [e.reason_code, e.consumed?.total]), [["TOOL_LIMIT_EXCEEDED", 80], ["TOOL_LIMIT_EXCEEDED", 110]]);
  });

  it("concurrent calls cannot both spend the last of the budget", async () => {
    const { proof, paid, pay } = await setup({ policy: policyText(50) });
    const contract = proof.acceptContract(proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    const tools = pay(contract);
    const results = await Promise.allSettled([tools("payments.send", send(30)), tools("payments.send", send(30))]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(paid.length, 1);
  });
});

describe("state survives a restart", () => {
  it("the budget is not reset by restarting the verifier", async () => {
    const state = new MemoryStateStore();
    const a = await setup({ state });
    const contract = a.proof.acceptContract(a.proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    await a.pay(contract)("payments.send", send(50));
    await a.pay(contract)("payments.send", send(50));

    const b = await setup({ state }); // "restart"
    assert.equal(b.proof.stateOf(contract), "running");
    await b.pay(contract)("payments.send", send(50));
    await b.pay(contract)("payments.send", send(50));
    await assert.rejects(b.pay(contract)("payments.send", send(50)), (e) => reasonOf(e) === "TOOL_LIMIT_EXCEEDED");
    assert.equal(a.paid.length + b.paid.length, 4);
  });

  it("re-issuing the same task after a restart is still refused, and replay is still caught", async () => {
    const state = new MemoryStateStore();
    const a = await setup({ state });
    const contract = a.proof.acceptContract(a.proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    const first = await a.proof.verifyCompletion({ contract, output: {}, identity: PAYER });
    assert.equal(first.decision, "allow");

    const b = await setup({ state });
    assert.throws(() => b.proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), /already has/);
    const replay = await b.proof.verifyCompletion({ contract, output: {}, identity: PAYER });
    assert.ok(replay.reason_codes.includes("CONTRACT_REPLAY"));
    await assert.rejects(b.pay(contract)("payments.send", send(1)), (e) => reasonOf(e) === "CONTRACT_STATE_INVALID");
  });

  it("approvals are single-use across restarts and can be granted after one", async () => {
    const state = new MemoryStateStore();
    const policy = `
api_version: agentproof/v1
policy: { id: answers, version: 1 }
mode: enforce
enforcement: { on_required_check_fail: review }
`;
    const a = await setup({ state, policy });
    const output = { claims: [{ id: "c1", text: "Unsupported.", evidence_ids: [] }] };
    const receipt = await a.proof.verifyAnswer({ output });
    assert.equal(receipt.evaluated_decision, "review");

    const b = await setup({ state, policy });
    const approval = b.proof.approve(receipt, { id: "reviewer@example" });
    const c = await setup({ state, policy });
    c.proof.redeemApproval(approval, { receipt, output });
    const d = await setup({ state, policy });
    assert.throws(() => d.proof.redeemApproval(approval, { receipt, output }), /already redeemed/);
  });

  it("an attempt interrupted mid-verification can be retried after a restart", async () => {
    const state = new MemoryStateStore();
    const a = await setup({ state });
    const contract = a.proof.acceptContract(a.proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    // Simulate a crash after 'submitted' was saved but before the receipt existed.
    const saved = state.load()!;
    saved.attempts[0]!.state = "submitted";
    state.save(saved);
    const b = await setup({ state });
    assert.equal(b.proof.stateOf(contract), "rejected");
    assert.ok(b.proof.retry(contract));
  });

  it("a contract restored under an edited policy can no longer call tools", async () => {
    const state = new MemoryStateStore();
    const a = await setup({ state });
    const contract = a.proof.acceptContract(a.proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    const b = await setup({ state, policy: policyText(1000) });
    await assert.rejects(b.pay(contract)("payments.send", send(1)), (e) => reasonOf(e) === "CONTRACT_POLICY_CHANGED");
  });

  it("if usage cannot be saved, the tool does not run", async () => {
    let fail = false;
    const inner = new MemoryStateStore();
    const flaky: StateStore = { load: () => inner.load(), save: (s) => (fail ? (() => { throw new Error("disk full"); })() : inner.save(s)) };
    const { proof, paid, pay } = await setup({ state: flaky });
    const contract = proof.acceptContract(proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    fail = true;
    await assert.rejects(pay(contract)("payments.send", send(10)), /disk full/);
    assert.equal(paid.length, 0);
  });

  it("FileStateStore writes a private file atomically and refuses a corrupt one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproof-state-"));
    const path = join(dir, "nested", "state.json");
    const a = await setup({ state: new FileStateStore(path) });
    const contract = a.proof.acceptContract(a.proof.issueContract("pay_invoice", { taskId: "inv-1", worker: PAYER, coordinator: BOSS }), { identity: PAYER });
    await a.pay(contract)("payments.send", send(50));
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);

    const b = await setup({ state: new FileStateStore(path) });
    assert.equal(b.proof.stateOf(contract), "running");

    writeFileSync(path, "{ not json");
    await assert.rejects(setup({ state: new FileStateStore(path) }), /not valid JSON/);
    writeFileSync(path, JSON.stringify({ version: 2 }));
    await assert.rejects(setup({ state: new FileStateStore(path) }), /not a valid verifier state/);
    assert.equal(new FileStateStore(join(dir, "missing.json")).load(), undefined);
  });
});
