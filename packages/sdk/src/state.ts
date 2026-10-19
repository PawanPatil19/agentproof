/**
 * Durable verifier state: contract attempts (with their tool events, which
 * carry spend and call counts), approvals, and the receipts approvals may be
 * granted against. Without it, a restart forgets every live contract, every
 * pending review and every single-use guarantee, and resets all budgets.
 *
 * The interface is synchronous on purpose: the guard records a call's usage
 * *before* the tool runs, and nothing else may interleave between the check
 * and the record. A store that cannot save makes the guarded call throw, so
 * an unrecorded call never runs.
 *
 * `FileStateStore` is for a single process. Two processes sharing one file
 * will overwrite each other; multi-node deployments need a store backed by a
 * database with row locks.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision } from "@agentproof/core";
import type { AttemptEntry } from "./ledger.ts";
import type { Approval } from "./verifier.ts";

/** What approvals need to know about a receipt this verifier issued. */
export interface IssuedReceiptRef {
  receipt_sha256: string;
  run_id: string;
  output_sha256: string;
  policy_digest: string;
  evaluated_decision: Decision;
}

export interface ApprovalRecord {
  approval: Approval;
  used: boolean;
}

export interface VerifierState {
  version: 1;
  attempts: AttemptEntry[];
  approvals: ApprovalRecord[];
  receipts: IssuedReceiptRef[];
}

export interface StateStore {
  /** The last saved state, or `undefined` if nothing was ever saved. Throws if the saved state is unreadable. */
  load(): VerifierState | undefined;
  /** Replace the saved state. Must be durable when it returns. */
  save(state: VerifierState): void;
}

/** Throws unless `value` has the shape of a saved state. A corrupt file must not silently reset budgets. */
export function assertVerifierState(value: unknown, source = "state"): asserts value is VerifierState {
  const v = value as Partial<VerifierState> | null;
  const ok =
    v !== null &&
    typeof v === "object" &&
    v.version === 1 &&
    Array.isArray(v.attempts) &&
    Array.isArray(v.approvals) &&
    Array.isArray(v.receipts) &&
    v.attempts.every((a) => a && typeof a === "object" && typeof a.contract?.attempt_id === "string" && typeof a.state === "string" && Array.isArray(a.toolEvents)) &&
    v.approvals.every((a) => a && typeof a === "object" && typeof a.approval?.approval_id === "string" && typeof a.used === "boolean") &&
    v.receipts.every((r) => r && typeof r === "object" && typeof r.receipt_sha256 === "string");
  if (!ok) throw new Error(`AgentProof ${source} is not a valid verifier state (version 1). Refusing to start with it.`);
}

/** Keeps a serialized copy, so a second verifier on the same store behaves like a restarted process. */
export class MemoryStateStore implements StateStore {
  private json?: string;
  load(): VerifierState | undefined {
    if (this.json === undefined) return undefined;
    const state: unknown = JSON.parse(this.json);
    assertVerifierState(state);
    return state;
  }
  save(state: VerifierState): void {
    this.json = JSON.stringify(state);
  }
}

/** One JSON file, written atomically (temp file + rename) and readable only by the current user. */
export class FileStateStore implements StateStore {
  readonly path: string;
  constructor(path = "agentproof-state/state.json") {
    this.path = path;
  }

  load(): VerifierState | undefined {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let state: unknown;
    try {
      state = JSON.parse(text);
    } catch {
      throw new Error(`AgentProof state file ${this.path} is not valid JSON. Refusing to start with it.`);
    }
    assertVerifierState(state, `state file ${this.path}`);
    return state;
  }

  save(state: VerifierState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(state)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}
