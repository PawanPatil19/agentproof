/**
 * @agentproof/sdk — runtime gates for agent handoffs.
 *
 *   const proof = await createVerifier({ policyFile: "./agentproof.yaml" });
 *   const contract = proof.issueContract("research_to_writer", { taskId, worker, coordinator });
 *   proof.acceptContract(contract, { identity: worker });
 *   const tools = proof.guardTools(realTools, contract, { identity: worker });
 *   const receipt = await proof.verifyCompletion({ contract, output, evidence, identity: worker });
 */
export { createVerifier, Verifier, type Approval, type ToolExecutor, type VerifierOptions } from "./verifier.ts";
export { ContractLedger, type AttemptEntry, type AttemptState } from "./ledger.ts";
export { FileStateStore, MemoryStateStore, assertVerifierState, type ApprovalRecord, type IssuedReceiptRef, type StateStore, type VerifierState } from "./state.ts";
export { FileReceiptStore, MemoryReceiptStore, writePrivateFile, type ReceiptStore } from "./store.ts";
export { AgentProofError, ApprovalError, ContractError, ToolBlockedError, type ApprovalFailure } from "./errors.ts";
