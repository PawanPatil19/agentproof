// Acceptance A03: contracts bind both parties; retries keep linkage; nothing is accepted silently.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContractError } from "@agentproof/sdk";
import { clock, COORDINATOR, deliverable, verifier, WORKER } from "./helpers.ts";

const issue = async (opts = {}) => {
  const proof = await verifier(opts);
  const contract = proof.issueContract("research_to_writer", { taskId: "task-42", worker: WORKER, coordinator: COORDINATOR });
  return { proof, contract };
};

describe("contract lifecycle", () => {
  it("issue → accept → complete validates", async () => {
    const { proof, contract } = await issue();
    assert.equal(proof.stateOf(contract), "proposed");
    const accepted = proof.acceptContract(contract, { identity: WORKER });
    assert.equal(accepted.acceptance?.digest, contract.digest);
    const receipt = await proof.verifyCompletion({ contract: accepted, ...deliverable, identity: WORKER });
    assert.equal(receipt.decision, "allow", JSON.stringify(receipt.checks.filter((c) => c.status !== "pass")));
    assert.equal(proof.stateOf(contract), "validated");
  });

  it("rejects completion without acceptance", async () => {
    const { proof, contract } = await issue();
    const receipt = await proof.verifyCompletion({ contract, ...deliverable, identity: WORKER });
    assert.ok(receipt.reason_codes.includes("CONTRACT_NOT_ACCEPTED"));
    assert.equal(receipt.decision, "block");
  });

  it("only the bound worker may accept", async () => {
    const { proof, contract } = await issue();
    assert.throws(() => proof.acceptContract(contract, { identity: "agent://intruder" }), (e: ContractError) => e.reason === "CONTRACT_IDENTITY_MISMATCH");
  });

  it("rejects completion from another identity without burning the worker's attempt", async () => {
    const { proof, contract } = await issue();
    const accepted = proof.acceptContract(contract, { identity: WORKER });
    const forged = await proof.verifyCompletion({ contract: accepted, ...deliverable, identity: "agent://intruder" });
    assert.ok(forged.reason_codes.includes("CONTRACT_IDENTITY_MISMATCH"));
    const real = await proof.verifyCompletion({ contract: accepted, ...deliverable, identity: WORKER });
    assert.equal(real.decision, "allow");
  });

  it("detects a contract edited in flight", async () => {
    const { proof, contract } = await issue();
    const accepted = proof.acceptContract(contract, { identity: WORKER });
    const loosened = { ...accepted, deadline_at: "2099-01-01T00:00:00.000Z" };
    assert.throws(() => proof.retry(loosened), (e: ContractError) => e.reason === "CONTRACT_DIGEST_MISMATCH");
    const receipt = await proof.verifyCompletion({ contract: loosened, ...deliverable, identity: WORKER });
    assert.ok(receipt.reason_codes.includes("CONTRACT_DIGEST_MISMATCH"));
  });

  it("rejects replayed completions", async () => {
    const { proof, contract } = await issue();
    const accepted = proof.acceptContract(contract, { identity: WORKER });
    await proof.verifyCompletion({ contract: accepted, ...deliverable, identity: WORKER });
    const replay = await proof.verifyCompletion({ contract: accepted, ...deliverable, identity: WORKER });
    assert.ok(replay.reason_codes.includes("CONTRACT_REPLAY"));
    assert.equal(replay.decision, "block");
    assert.equal(proof.stateOf(contract), "validated", "a replay must not change the original outcome");
  });

  it("rejects late completions", async () => {
    const time = clock();
    const { proof, contract } = await issue({ now: time.now });
    const accepted = proof.acceptContract(contract, { identity: WORKER });
    time.advance(31_000);
    const receipt = await proof.verifyCompletion({ contract: accepted, ...deliverable, identity: WORKER });
    assert.ok(receipt.reason_codes.includes("CONTRACT_EXPIRED"));
  });

  it("retries keep the task, get a new attempt id, link to the parent, and are bounded", async () => {
    const { proof, contract } = await issue();
    const first = proof.acceptContract(contract, { identity: WORKER });
    await proof.verifyCompletion({ contract: first, output: { claims: [] }, evidence: [], identity: WORKER });
    assert.equal(proof.stateOf(first), "rejected");

    const second = proof.retry(first);
    assert.equal(second.task_id, first.task_id);
    assert.equal(second.attempt, 2);
    assert.notEqual(second.attempt_id, first.attempt_id);
    assert.equal(second.parent_attempt_id, first.attempt_id);
    assert.equal(second.definition_digest, first.definition_digest, "obligations are re-pinned, never weakened");
    assert.equal(proof.stateOf(first), "superseded");

    const late = await proof.verifyCompletion({ contract: first, ...deliverable, identity: WORKER });
    assert.ok(late.reason_codes.includes("CONTRACT_REPLAY") || late.reason_codes.includes("CONTRACT_STATE_INVALID"));

    proof.acceptContract(second, { identity: WORKER });
    assert.throws(() => proof.retry(second), (e: ContractError) => e.reason === "REPAIR_LIMIT_REACHED");
  });

  it("binds logical agent names to registered identities", async () => {
    const proof = await verifier({ identities: { researcher: [WORKER], writer: [COORDINATOR] } });
    assert.throws(
      () => proof.issueContract("research_to_writer", { taskId: "t", worker: "agent://someone-else", coordinator: COORDINATOR }),
      (e: ContractError) => e.reason === "CONTRACT_IDENTITY_MISMATCH",
    );
    assert.throws(() => proof.issueContract("nope", { taskId: "t", worker: WORKER, coordinator: COORDINATOR }), (e: ContractError) => e.reason === "CONTRACT_UNKNOWN");
  });
});
