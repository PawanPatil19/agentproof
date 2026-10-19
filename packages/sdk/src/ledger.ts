/**
 * In-memory record of every contract attempt this verifier issued.
 *
 *   proposed → accepted → running → submitted → validated | rejected
 *                                             ↘ superseded (a retry replaced it)
 *
 * The ledger's copy of a contract is authoritative: whatever object a caller
 * passes back is compared against it, so edits to a contract in flight are caught.
 */
import type { ContractInstance, ToolEvent } from "@agentproof/core";

export type AttemptState = "proposed" | "accepted" | "running" | "submitted" | "validated" | "rejected" | "superseded";

export interface AttemptEntry {
  contract: ContractInstance;
  state: AttemptState;
  toolEvents: ToolEvent[];
}

export class ContractLedger {
  private readonly attempts = new Map<string, AttemptEntry>();

  add(contract: ContractInstance): AttemptEntry {
    const entry: AttemptEntry = { contract, state: "proposed", toolEvents: [] };
    this.attempts.set(contract.attempt_id, entry);
    return entry;
  }

  get(attemptId: string): AttemptEntry | undefined {
    return this.attempts.get(attemptId);
  }

  /** All attempts for a task, oldest first. */
  forTask(taskId: string): AttemptEntry[] {
    return [...this.attempts.values()].filter((e) => e.contract.task_id === taskId);
  }
}
