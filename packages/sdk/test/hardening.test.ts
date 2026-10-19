// Regression tests for the advisor review (SDK side).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { seal } from "@agentproof/core";
import { ApprovalError, ContractError, FileReceiptStore, type ReceiptStore } from "@agentproof/sdk";
import { COORDINATOR, deliverable, verifier, WORKER } from "./helpers.ts";

const binding = { taskId: "task-42", worker: WORKER, coordinator: COORDINATOR };

describe("finding 2: approvals only for receipts this verifier issued", () => {
  it("rejects a block receipt edited to 'review' and re-sealed", async () => {
    const proof = await verifier({ mode: "enforce" });
    const blocked = await proof.verifyAnswer({ output: { text: "x", claims: [{ text: "x", evidence_ids: ["missing"] }] } });
    assert.equal(blocked.decision, "block");
    const forged = seal({ ...blocked, evaluated_decision: "review", decision: "review" });
    assert.throws(() => proof.approve(forged, { id: "reviewer" }), (e: ApprovalError) => e.reason === "APPROVAL_RECEIPT_MISMATCH");
  });

  it("rejects receipts from another verifier", async () => {
    const other = await verifier({ mode: "enforce" });
    const foreign = await other.verifyAnswer({ output: { text: "x", claims: [{ text: "x", evidence_ids: ["d1"] }] }, evidence: [{ id: "d1" }] });
    const proof = await verifier({ mode: "enforce" });
    assert.throws(() => proof.approve(foreign, { id: "reviewer" }), ApprovalError);
  });
});

describe("finding 3: no ledger bypass", () => {
  it("the SDK has no unverified envelope entry point", async () => {
    const proof = await verifier();
    assert.equal((proof as unknown as Record<string, unknown>).verifyEnvelope, undefined);
  });
});

describe("finding 7: the repair limit cannot be reset", () => {
  it("re-issuing the same contract for the same task throws", async () => {
    const proof = await verifier();
    proof.issueContract("research_to_writer", binding);
    assert.throws(() => proof.issueContract("research_to_writer", binding), (e: ContractError) => e.reason === "CONTRACT_STATE_INVALID");
  });
});

describe("finding 8: no retry while a completion is in flight", () => {
  it("retry() during persistence throws, and the attempt settles normally", async () => {
    let release!: () => void;
    const slow: ReceiptStore = { save: () => new Promise<void>((resolve) => (release = resolve)) };
    const proof = await verifier({ store: slow });
    const contract = proof.acceptContract(proof.issueContract("research_to_writer", binding), { identity: WORKER });
    const pending = proof.verifyCompletion({ contract, ...deliverable, identity: WORKER });
    await new Promise((r) => setImmediate(r));
    assert.equal(proof.stateOf(contract), "submitted");
    assert.throws(() => proof.retry(contract), (e: ContractError) => e.reason === "CONTRACT_STATE_INVALID");
    release();
    await pending;
    assert.equal(proof.stateOf(contract), "validated");
  });
});

describe("observe-mode violations still count", () => {
  it("a tool call before acceptance fails tools.permission even though it ran", async () => {
    const proof = await verifier({ mode: "observe" });
    const proposed = proof.issueContract("research_to_writer", binding);
    await proof.guardTools(async () => "ok", proposed, { identity: WORKER })("docs.read", {});
    const accepted = proof.acceptContract(proposed, { identity: WORKER });
    const receipt = await proof.verifyCompletion({ contract: accepted, ...deliverable, identity: WORKER });
    assert.equal(receipt.decision, "allow");
    assert.equal(receipt.evaluated_decision, "block");
    assert.ok(receipt.reason_codes.includes("CONTRACT_NOT_ACCEPTED"));
  });
});

describe("approvals hash outputs the same way receipts do", () => {
  it("an output containing a Date can be approved and redeemed", async () => {
    const proof = await verifier({ mode: "enforce" });
    const output = { text: "x", at: new Date("2026-10-19T00:00:00Z"), claims: deliverable.output.claims };
    const receipt = await proof.verifyAnswer({ output, evidence: [{ ...deliverable.evidence[0]!, content: undefined }] });
    assert.equal(receipt.decision, "review");
    proof.redeemApproval(proof.approve(receipt, { id: "reviewer" }), { receipt, output });
  });
});

describe("receipt store", () => {
  it("a run_id of 'latest' cannot overwrite latest.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentproof-store-"));
    const store = new FileReceiptStore(dir);
    const proof = await verifier({ store });
    await proof.verifyAnswer({ output: deliverable.output, evidence: deliverable.evidence, runId: "latest" });
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "run-latest.json"]);
  });
});
