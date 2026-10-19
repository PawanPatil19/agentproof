/**
 * The runtime gate. Sits beside the host application and decides, at three
 * boundaries, whether work may continue:
 *
 *   1. pre-tool          guardTools()        — before a worker's tool call executes
 *   2. worker completion verifyCompletion()  — before a coordinator consumes a deliverable
 *   3. final answer      verifyAnswer()      — before anything is shown to a person
 *
 * The SDK assumes a trusted host: a compromised application can bypass any
 * in-process gate. Identities passed here must come from the host's own
 * execution context, never from agent-supplied strings.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  amendReceipt,
  baselinePolicy,
  contractInstanceDigest,
  hashOutput,
  parsePolicy,
  verifyRun,
  type CheckResult,
  type CompiledPolicy,
  type ContractInstance,
  type EvidenceRecord,
  type Mode,
  type RawResult,
  type ReasonCode,
  type Receipt,
  type RunEnvelope,
  type ToolEvent,
} from "@agentproof/core";
import { ApprovalError, ContractError, ToolBlockedError } from "./errors.ts";
import { ContractLedger, type AttemptEntry } from "./ledger.ts";
import { FileReceiptStore, type ReceiptStore } from "./store.ts";

export type ToolExecutor<T = unknown> = (tool: string, args: unknown) => Promise<T>;

export interface VerifierOptions {
  /** A compiled policy, YAML text, or a path to `agentproof.yaml`. Defaults to the baseline preset. */
  policy?: CompiledPolicy;
  policyText?: string;
  policyFile?: string;
  /** Override the policy's mode. */
  mode?: Mode;
  /**
   * Allowed runtime identities per logical agent name in the policy, e.g.
   * `{ researcher: ["agent://researcher-1"] }`. When set, contracts can only be
   * issued to identities listed for the contract's declared worker/coordinator.
   */
  identities?: Record<string, string[]>;
  /** Where receipts go. `false` disables persistence (tests, ephemeral runs). */
  store?: ReceiptStore | false;
  now?: () => Date;
  newId?: () => string;
}

export interface Approval {
  approval_id: string;
  run_id: string;
  receipt_sha256: string;
  output_sha256: string;
  policy_digest: string;
  reviewer: string;
  reason?: string;
  issued_at: string;
  expires_at: string;
}

export async function createVerifier(options: VerifierOptions = {}): Promise<Verifier> {
  let policy = options.policy;
  if (!policy && options.policyText !== undefined) policy = parsePolicy(options.policyText);
  if (!policy && options.policyFile) policy = parsePolicy(await readFile(options.policyFile, "utf8"));
  return new Verifier({ ...options, policy: policy ?? baselinePolicy() });
}

const lifecycle = (status: CheckResult["status"], reason: ReasonCode, message: string): RawResult => ({
  check: "contract.lifecycle",
  kind: "deterministic",
  target: "contract",
  status,
  reason,
  message,
});

export class Verifier {
  readonly policy: CompiledPolicy;
  readonly mode: Mode;
  private readonly store: ReceiptStore | false;
  private readonly identities?: Record<string, string[]>;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly ledger = new ContractLedger();
  private readonly approvals = new Map<string, { approval: Approval; used: boolean }>();
  /** Every receipt this verifier produced, by digest. Approvals are only ever granted against these. */
  private readonly issuedReceipts = new Map<string, Receipt>();

  constructor(options: VerifierOptions & { policy: CompiledPolicy }) {
    this.policy = options.policy;
    this.mode = options.mode ?? options.policy.mode;
    this.store = options.store === undefined ? new FileReceiptStore() : options.store;
    this.identities = options.identities;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID().replace(/-/g, "").slice(0, 16));
  }

  // ── Contract lifecycle ─────────────────────────────────────────────────────

  /** Issue a contract from the policy to one worker for one task. State: proposed. */
  issueContract(name: string, binding: { taskId: string; worker: string; coordinator: string }): ContractInstance {
    // Re-issuing would reset the attempt counter and dodge the repair limit.
    if (this.ledger.forTask(binding.taskId).some((e) => e.contract.name === name)) {
      throw new ContractError("CONTRACT_STATE_INVALID", `Task ${binding.taskId} already has a '${name}' contract; use retry() for another attempt.`);
    }
    return this.issue(name, binding.taskId, binding.worker, binding.coordinator, 1);
  }

  /**
   * The worker accepts the exact digest it was issued. Fails if the identity is
   * not the bound worker or the contract object was edited. State: accepted.
   */
  acceptContract(contract: ContractInstance, worker: { identity: string }): ContractInstance {
    const entry = this.entryFor(contract);
    if (entry.state !== "proposed") throw new ContractError("CONTRACT_STATE_INVALID", `Contract attempt is '${entry.state}', not 'proposed'.`);
    if (worker.identity !== entry.contract.worker) {
      throw new ContractError("CONTRACT_IDENTITY_MISMATCH", `Only ${entry.contract.worker} may accept this contract.`);
    }
    entry.contract = Object.freeze({
      ...entry.contract,
      acceptance: { identity: worker.identity, digest: entry.contract.digest, at: this.now().toISOString() },
    });
    entry.state = "accepted";
    return entry.contract;
  }

  /**
   * Issue the next attempt after a rejected (or abandoned) one. Obligations
   * are re-pinned from the same policy — a retry can never weaken them.
   * Bounded by `enforcement.max_repair_attempts`.
   */
  retry(previous: ContractInstance): ContractInstance {
    const entry = this.entryFor(previous);
    if (entry.state === "validated") throw new ContractError("CONTRACT_STATE_INVALID", "Attempt already validated; nothing to repair.");
    if (entry.state === "superseded") throw new ContractError("CONTRACT_STATE_INVALID", "Attempt was already retried.");
    if (entry.state === "submitted") throw new ContractError("CONTRACT_STATE_INVALID", "Attempt is being verified; wait for its receipt before retrying.");
    const repairs = entry.contract.attempt; // attempt 1 → this is repair #1
    if (repairs > this.policy.enforcement.maxRepairAttempts) {
      throw new ContractError("REPAIR_LIMIT_REACHED", `Repair limit (${this.policy.enforcement.maxRepairAttempts}) reached for task ${entry.contract.task_id}.`);
    }
    entry.state = "superseded";
    const c = entry.contract;
    return this.issue(c.name, c.task_id, c.worker, c.coordinator, c.attempt + 1, c.attempt_id);
  }

  /** Current lifecycle state of an attempt (for UIs and tests). */
  stateOf(contract: ContractInstance): AttemptEntry["state"] | undefined {
    return this.ledger.get(contract.attempt_id)?.state;
  }

  // ── Boundary 1: tool calls ─────────────────────────────────────────────────

  /**
   * Wrap a tool executor so every call is checked *before* it runs. In
   * enforce mode a disallowed call throws ToolBlockedError and the real tool
   * is never invoked. `caller.identity` must come from the host, not the agent.
   */
  guardTools<T>(executor: ToolExecutor<T>, contract: ContractInstance, caller: { identity: string }): ToolExecutor<T> {
    return async (tool, args) => {
      const entry = this.ledger.get(contract.attempt_id);
      const violation = this.toolViolation(entry, tool, caller.identity);
      const event: ToolEvent = { tool, agent: caller.identity, at: this.now().toISOString(), outcome: "invoked" };
      if (violation) Object.assign(event, { reason: violation.message, reason_code: violation.reason });

      if (violation && this.mode === "enforce") {
        entry?.toolEvents.push({ ...event, outcome: "blocked" });
        throw new ToolBlockedError(tool, violation.reason, violation.message);
      }
      if (entry) {
        entry.toolEvents.push(event);
        if (entry.state === "accepted") entry.state = "running";
      }
      return executor(tool, args);
    };
  }

  // ── Boundary 2: worker completion ──────────────────────────────────────────

  /**
   * Check a worker's deliverable against its contract before the coordinator
   * consumes it. Lifecycle problems (replay, wrong identity, edited contract,
   * superseded attempt) are recorded as `contract.lifecycle` results.
   */
  async verifyCompletion(input: {
    contract: ContractInstance;
    output: unknown;
    evidence?: EvidenceRecord[];
    /** Trusted identity of the agent submitting the output. */
    identity: string;
    runId?: string;
  }): Promise<Receipt> {
    const entry = this.ledger.get(input.contract.attempt_id);
    const extra: RawResult[] = [];
    if (!entry) {
      extra.push(lifecycle("fail", "CONTRACT_UNKNOWN", "This contract attempt was not issued by this verifier."));
    } else if (["submitted", "validated", "rejected"].includes(entry.state)) {
      extra.push(lifecycle("fail", "CONTRACT_REPLAY", `Attempt ${entry.contract.attempt} was already submitted (state '${entry.state}'). Duplicate or late completions are never accepted silently.`));
    } else if (entry.state === "superseded") {
      extra.push(lifecycle("fail", "CONTRACT_STATE_INVALID", `Attempt ${entry.contract.attempt} was superseded by a retry.`));
    } else if (input.identity !== entry.contract.worker) {
      extra.push(lifecycle("fail", "CONTRACT_IDENTITY_MISMATCH", "Output submitted by an identity other than the bound worker."));
    } else if (input.contract.digest !== entry.contract.digest || contractInstanceDigest(input.contract) !== entry.contract.digest) {
      extra.push(lifecycle("fail", "CONTRACT_DIGEST_MISMATCH", "The contract presented at completion differs from the one issued."));
    } else {
      extra.push(lifecycle("pass", "OK", `Attempt ${entry.contract.attempt} submitted once by the bound worker.`));
    }
    // Only a legitimate first submission moves the attempt forward; a forged or
    // duplicate one must not burn the real worker's attempt.
    const firstSubmission = entry !== undefined && extra[0]?.status === "pass";
    if (entry && firstSubmission) entry.state = "submitted";

    const envelope: RunEnvelope = {
      api_version: "agentproof/v1",
      run_id: input.runId ?? `run_${this.newId()}`,
      task_id: input.contract.task_id,
      boundary: "worker_completion",
      output: input.output,
      evidence: input.evidence ?? [],
      tool_events: entry ? [...entry.toolEvents] : [],
      // The ledger's copy is authoritative; the caller's copy was compared above.
      contract: entry?.contract ?? input.contract,
      submitted_at: this.now().toISOString(),
    };
    const receipt = await this.finish(verifyRun(envelope, { policy: this.policy, mode: this.mode, now: this.now, extraResults: extra }));
    // Only settle an attempt that is still ours to settle.
    if (entry && firstSubmission && entry.state === "submitted") entry.state = receipt.evaluated_decision === "allow" ? "validated" : "rejected";
    return receipt;
  }

  // ── Boundary 3: final answer ───────────────────────────────────────────────

  /** Check a final answer before release. Buffer streamed output until this resolves. */
  async verifyAnswer(input: { output: unknown; evidence?: EvidenceRecord[]; taskId?: string; runId?: string }): Promise<Receipt> {
    const envelope: RunEnvelope = {
      api_version: "agentproof/v1",
      run_id: input.runId ?? `run_${this.newId()}`,
      task_id: input.taskId,
      boundary: "final_answer",
      output: input.output,
      evidence: input.evidence ?? [],
      submitted_at: this.now().toISOString(),
    };
    return this.finish(verifyRun(envelope, { policy: this.policy, mode: this.mode, now: this.now }));
  }

  // ── Review ─────────────────────────────────────────────────────────────────

  /**
   * A reviewer approves a receipt whose policy outcome was `review`. The
   * approval is bound to that exact output hash and receipt, expires after
   * `review_timeout_ms`, and can be redeemed once. Blocks cannot be approved.
   */
  approve(presented: Receipt, reviewer: { id: string; reason?: string }): Approval {
    // Decide from our own copy, never from the object the caller hands back.
    const receipt = this.issuedReceipts.get(presented.receipt_sha256);
    if (!receipt) throw new ApprovalError("APPROVAL_RECEIPT_MISMATCH", "Receipt was not issued by this verifier (or was edited).");
    if (receipt.evaluated_decision !== "review") {
      throw new ApprovalError("APPROVAL_NOT_REVIEWABLE", `Only 'review' outcomes can be approved; this receipt is '${receipt.evaluated_decision}'.`);
    }
    const issued = this.now();
    const approval: Approval = Object.freeze({
      approval_id: `apr_${this.newId()}`,
      run_id: receipt.run_id,
      receipt_sha256: receipt.receipt_sha256,
      output_sha256: receipt.output_sha256,
      policy_digest: receipt.policy.digest,
      reviewer: reviewer.id,
      reason: reviewer.reason,
      issued_at: issued.toISOString(),
      expires_at: new Date(issued.getTime() + this.policy.enforcement.reviewTimeoutMs).toISOString(),
    });
    this.approvals.set(approval.approval_id, { approval, used: false });
    return approval;
  }

  /** Redeem an approval for release. Throws if expired, reused, or the output changed. */
  redeemApproval(approval: Approval, release: { receipt: Receipt; output: unknown }): void {
    const record = this.approvals.get(approval.approval_id);
    if (!record) throw new ApprovalError("APPROVAL_UNKNOWN", "Approval was not issued by this verifier.");
    if (record.used) throw new ApprovalError("APPROVAL_USED", "Approval was already redeemed.");
    if (this.now().getTime() > Date.parse(record.approval.expires_at)) {
      throw new ApprovalError("APPROVAL_EXPIRED", "Approval expired; review timeouts block release.");
    }
    if (release.receipt.receipt_sha256 !== record.approval.receipt_sha256) {
      throw new ApprovalError("APPROVAL_RECEIPT_MISMATCH", "Approval belongs to a different receipt.");
    }
    if (hashOutput(release.output) !== record.approval.output_sha256) {
      throw new ApprovalError("APPROVAL_OUTPUT_CHANGED", "Output changed after review; it must be verified again.");
    }
    record.used = true;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private issue(name: string, taskId: string, worker: string, coordinator: string, attempt: number, parent?: string): ContractInstance {
    const compiled = this.policy.contracts.get(name);
    if (!compiled) throw new ContractError("CONTRACT_UNKNOWN", `Policy ${this.policy.id} declares no contract '${name}'.`);
    this.assertIdentity(compiled.definition.worker, worker);
    this.assertIdentity(compiled.definition.coordinator, coordinator);
    if (worker === coordinator) throw new ContractError("CONTRACT_IDENTITY_MISMATCH", "Worker and coordinator must be different identities.");

    const issued = this.now();
    const terms = {
      name,
      version: compiled.definition.version,
      definition_digest: compiled.definitionDigest,
      task_id: taskId,
      attempt_id: `att_${this.newId()}`,
      attempt,
      ...(parent ? { parent_attempt_id: parent } : {}),
      coordinator,
      worker,
      issued_at: issued.toISOString(),
      deadline_at: new Date(issued.getTime() + compiled.definition.deadline_ms).toISOString(),
    };
    const contract: ContractInstance = Object.freeze({ ...terms, digest: contractInstanceDigest(terms) });
    this.ledger.add(contract);
    return contract;
  }

  private assertIdentity(logicalName: string, identity: string): void {
    const allowed = this.identities?.[logicalName];
    if (this.identities && !allowed?.includes(identity)) {
      throw new ContractError("CONTRACT_IDENTITY_MISMATCH", `Identity '${identity}' is not registered for agent '${logicalName}'.`);
    }
  }

  private entryFor(contract: ContractInstance): AttemptEntry {
    const entry = this.ledger.get(contract.attempt_id);
    if (!entry) throw new ContractError("CONTRACT_UNKNOWN", "This contract attempt was not issued by this verifier.");
    if (contract.digest !== entry.contract.digest || contractInstanceDigest(contract) !== entry.contract.digest) {
      throw new ContractError("CONTRACT_DIGEST_MISMATCH", "Contract terms differ from the issued contract.");
    }
    return entry;
  }

  private toolViolation(entry: AttemptEntry | undefined, tool: string, identity: string): { reason: ReasonCode; message: string } | undefined {
    if (!entry) return { reason: "CONTRACT_UNKNOWN", message: "Tool call under a contract this verifier did not issue." };
    const c = entry.contract;
    if (identity !== c.worker) return { reason: "CONTRACT_IDENTITY_MISMATCH", message: `${identity} is not the contracted worker.` };
    if (entry.state === "proposed") return { reason: "CONTRACT_NOT_ACCEPTED", message: "Contract not accepted yet; no tool calls allowed." };
    if (entry.state !== "accepted" && entry.state !== "running") {
      return { reason: "CONTRACT_STATE_INVALID", message: `Contract attempt is '${entry.state}'; no further tool calls allowed.` };
    }
    if (this.now().getTime() > Date.parse(c.deadline_at)) return { reason: "CONTRACT_EXPIRED", message: "Contract deadline has passed." };
    const allowed = this.policy.contracts.get(c.name)?.definition.allowed_tools;
    if (allowed && !allowed.includes(tool)) return { reason: "TOOL_NOT_ALLOWED", message: `'${tool}' is not in allowed_tools for ${c.name}.` };
    return undefined;
  }

  /** Persist before release. If a durable receipt cannot be written, protected release is blocked. */
  private async finish(evaluated: Receipt): Promise<Receipt> {
    const receipt = await this.persist(evaluated);
    this.issuedReceipts.set(receipt.receipt_sha256, receipt);
    return receipt;
  }

  private async persist(receipt: Receipt): Promise<Receipt> {
    if (this.store === false) return receipt;
    try {
      await this.store.save(receipt);
      return receipt;
    } catch (error) {
      return amendReceipt(
        receipt,
        [{ check: "receipt.persistence", kind: "deterministic", target: "store", status: "fail", reason: "RECEIPT_PERSIST_FAILED", message: `Receipt could not be persisted: ${(error as Error).message}`, required: true }],
        this.policy,
      );
    }
  }
}
