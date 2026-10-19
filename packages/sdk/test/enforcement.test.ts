// Acceptance A04 / A05: enforcement precedes effects; failure and review paths are explicit.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApprovalError, MemoryReceiptStore, ToolBlockedError, type ReceiptStore } from "@agentproof/sdk";
import { clock, COORDINATOR, deliverable, verifier, WORKER } from "./helpers.ts";

async function setup(opts = {}) {
  const proof = await verifier(opts);
  const contract = proof.acceptContract(proof.issueContract("research_to_writer", { taskId: "t", worker: WORKER, coordinator: COORDINATOR }), { identity: WORKER });
  const calls: string[] = [];
  const tools = proof.guardTools(async (tool) => void calls.push(tool), contract, { identity: WORKER });
  return { proof, contract, calls, tools };
}

describe("tool guard", () => {
  it("enforce: a disallowed tool is never invoked", async () => {
    const { proof, contract, calls, tools } = await setup({ mode: "enforce" });
    await tools("docs.read", {});
    await assert.rejects(tools("publish.post", {}), ToolBlockedError);
    assert.deepEqual(calls, ["docs.read"]);
    const receipt = await proof.verifyCompletion({ contract, ...deliverable, identity: WORKER });
    assert.equal(receipt.decision, "block");
    assert.ok(receipt.tool_events.some((e) => e.tool === "publish.post" && e.outcome === "blocked"));
  });

  it("observe: the call proceeds and the receipt records the would-be block", async () => {
    const { proof, contract, calls, tools } = await setup({ mode: "observe" });
    await tools("publish.post", {});
    assert.deepEqual(calls, ["publish.post"]);
    const receipt = await proof.verifyCompletion({ contract, ...deliverable, identity: WORKER });
    assert.equal(receipt.decision, "allow");
    assert.equal(receipt.evaluated_decision, "block");
    assert.deepEqual(receipt.reason_codes, ["TOOL_NOT_ALLOWED"]);
  });

  it("identity comes from the host binding, so another agent cannot borrow the guard", async () => {
    const proof = await verifier({ mode: "enforce" });
    const contract = proof.acceptContract(proof.issueContract("research_to_writer", { taskId: "t", worker: WORKER, coordinator: COORDINATOR }), { identity: WORKER });
    const intruderTools = proof.guardTools(async () => "ran", contract, { identity: "agent://intruder" });
    await assert.rejects(intruderTools("docs.read", {}), (e: ToolBlockedError) => e.reason === "CONTRACT_IDENTITY_MISMATCH");
  });

  it("blocks tool calls before acceptance and after the deadline", async () => {
    const time = clock();
    const proof = await verifier({ mode: "enforce", now: time.now });
    const proposed = proof.issueContract("research_to_writer", { taskId: "t", worker: WORKER, coordinator: COORDINATOR });
    await assert.rejects(proof.guardTools(async () => 1, proposed, { identity: WORKER })("docs.read", {}), (e: ToolBlockedError) => e.reason === "CONTRACT_NOT_ACCEPTED");
    const accepted = proof.acceptContract(proposed, { identity: WORKER });
    time.advance(30_001);
    await assert.rejects(proof.guardTools(async () => 1, accepted, { identity: WORKER })("docs.read", {}), (e: ToolBlockedError) => e.reason === "CONTRACT_EXPIRED");
  });
});

describe("failure paths", () => {
  it("blocks protected release when the receipt cannot be persisted", async () => {
    const failing: ReceiptStore = { save: async () => { throw new Error("disk full"); } };
    const { proof, contract } = await setup({ mode: "enforce", store: failing });
    const receipt = await proof.verifyCompletion({ contract, ...deliverable, identity: WORKER });
    assert.equal(receipt.decision, "block");
    assert.ok(receipt.reason_codes.includes("RECEIPT_PERSIST_FAILED"));
  });

  it("persists receipts before returning them", async () => {
    const store = new MemoryReceiptStore();
    const proof = await verifier({ store });
    const receipt = await proof.verifyAnswer({ output: deliverable.output, evidence: deliverable.evidence });
    assert.equal(store.receipts[0]?.receipt_sha256, receipt.receipt_sha256);
  });
});

describe("review approvals", () => {
  // Content not captured → the quote check is inconclusive → review. `content: undefined` must count as absent.
  const answer = { text: "Offline sync is GA.", claims: deliverable.output.claims };
  const inconclusive = { output: answer, evidence: [{ ...deliverable.evidence[0]!, content: undefined }] };

  it("are bound to the exact output and single use", async () => {
    const proof = await verifier({ mode: "enforce" });
    const receipt = await proof.verifyAnswer(inconclusive);
    assert.equal(receipt.decision, "review");
    const approval = proof.approve(receipt, { id: "reviewer@example.com", reason: "checked source manually" });

    const edited = { ...answer, text: "Edited after review." };
    assert.throws(() => proof.redeemApproval(approval, { receipt, output: edited }), (e: ApprovalError) => e.reason === "APPROVAL_OUTPUT_CHANGED");
    proof.redeemApproval(approval, { receipt, output: inconclusive.output });
    assert.throws(() => proof.redeemApproval(approval, { receipt, output: inconclusive.output }), (e: ApprovalError) => e.reason === "APPROVAL_USED");
  });

  it("expire after the review timeout", async () => {
    const time = clock();
    const proof = await verifier({ mode: "enforce", now: time.now });
    const receipt = await proof.verifyAnswer(inconclusive);
    const approval = proof.approve(receipt, { id: "reviewer" });
    time.advance(600_001);
    assert.throws(() => proof.redeemApproval(approval, { receipt, output: inconclusive.output }), (e: ApprovalError) => e.reason === "APPROVAL_EXPIRED");
  });

  it("cannot override a block", async () => {
    const proof = await verifier({ mode: "enforce" });
    const receipt = await proof.verifyAnswer({ output: { claims: [{ text: "x", evidence_ids: ["missing"] }] } });
    assert.equal(receipt.decision, "block");
    assert.throws(() => proof.approve(receipt, { id: "reviewer" }), (e: ApprovalError) => e.reason === "APPROVAL_NOT_REVIEWABLE");
  });
});
