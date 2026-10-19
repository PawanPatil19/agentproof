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
  evaluateToolCall,
  hashOutput,
  judgeClaims,
  parsePolicy,
  signReceipt,
  usageOf,
  verifyRun,
  type CheckResult,
  type CompiledPolicy,
  type ContractInstance,
  type EvidenceRecord,
  type Judge,
  type Mode,
  type RawResult,
  type ReasonCode,
  type Receipt,
  type RunEnvelope,
  type ToolEvent,
} from "@agentproof/core";
import { ApprovalError, ContractError, ToolBlockedError } from "./errors.ts";
import { ContractLedger, type AttemptEntry } from "./ledger.ts";
import { type ApprovalRecord, type IssuedReceiptRef, type StateStore } from "./state.ts";
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
  /**
   * Independent semantic judge, required when the policy enables
   * `checks.semantics`. Sees only claim + excerpt; never the agent's context.
   */
  judge?: Judge;
  /** Ed25519 private key (PKCS#8 PEM). When set, every receipt is signed before it is stored. */
  signingKeyPem?: string;
  /** Where receipts go. `false` disables persistence (tests, ephemeral runs). */
  store?: ReceiptStore | false;
  /**
   * Where contracts, tool usage and approvals are kept so they survive a
   * restart (e.g. `new FileStateStore("./agentproof-state/state.json")`).
   * Without one they live only in this process, and a restart resets budgets.
   */
  state?: StateStore;
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
  const compiled = policy ?? baselinePolicy();
  if (compiled.semantics.enabled && !options.judge) {
    throw new Error(`Policy ${compiled.id} enables checks.semantics but no judge was configured.`);
  }
  return new Verifier({ ...options, policy: compiled });
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
  private readonly judge?: Judge;
  private readonly signingKeyPem?: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly stateStore?: StateStore;
  private readonly ledger = new ContractLedger();
  private readonly approvals = new Map<string, ApprovalRecord>();
  /** Every receipt this verifier produced, by digest. Approvals are only ever granted against these. */
  private readonly issuedReceipts = new Map<string, IssuedReceiptRef>();

  constructor(options: VerifierOptions & { policy: CompiledPolicy }) {
    this.policy = options.policy;
    this.mode = options.mode ?? options.policy.mode;
    this.store = options.store === undefined ? new FileReceiptStore() : options.store;
    this.identities = options.identities;
    this.judge = options.judge;
    this.signingKeyPem = options.signingKeyPem;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID().replace(/-/g, "").slice(0, 16));
    this.stateStore = options.state;
    const saved = this.stateStore?.load();
    if (saved) {
      // A verification interrupted by the restart produced no receipt. Treat it
      // as rejected so the task can be retried instead of stuck in 'submitted'.
      this.ledger.restore(saved.attempts.map((a) => (a.state === "submitted" ? { ...a, state: "rejected" as const } : a)));
      for (const record of saved.approvals) this.approvals.set(record.approval.approval_id, { approval: Object.freeze({ ...record.approval }), used: record.used });
      for (const ref of saved.receipts) this.issuedReceipts.set(ref.receipt_sha256, ref);
    }
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
    this.saveState();
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
    // issue() saves the superseded state together with the new attempt.
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
      // Everything up to the executor call is synchronous, so concurrent calls
      // are checked and recorded one at a time and cannot both spend the same budget.
      const entry = this.ledger.get(contract.attempt_id);
      const now = this.now();
      const event: ToolEvent = { tool, agent: caller.identity, at: now.toISOString(), outcome: "invoked" };
      let violation = this.toolViolation(entry, tool, caller.identity);

      const compiled = entry && this.policy.contracts.get(entry.contract.name);
      const constraint = compiled?.toolConstraints.get(tool);
      let runs = !violation || this.mode !== "enforce";
      if (entry && compiled && constraint && !violation) {
        const prior = usageOf(this.taskToolEvents(entry), tool, now, constraint.definition.window_ms);
        const verdict = evaluateToolCall(compiled, tool, args, prior);
        if (verdict.amount !== undefined) event.amount = verdict.amount;
        if (!verdict.ok) violation = { reason: verdict.reason, message: verdict.message };
        runs = !violation || this.mode !== "enforce";
        const metered = constraint.definition.amount_field !== undefined;
        const used = runs ? { calls: prior.calls + 1, total: prior.total + (event.amount ?? 0) } : prior;
        event.consumed = metered ? used : { calls: used.calls };
      }
      if (violation) Object.assign(event, { reason: violation.message, reason_code: violation.reason });

      if (!runs) {
        if (entry) {
          entry.toolEvents.push({ ...event, outcome: "blocked" });
          this.saveState();
        }
        throw new ToolBlockedError(tool, violation!.reason, violation!.message);
      }
      if (entry) {
        entry.toolEvents.push(event);
        if (entry.state === "accepted") entry.state = "running";
        // Record usage before the tool runs. If it cannot be recorded, the call does not happen.
        this.saveState();
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
    if (entry && firstSubmission) {
      entry.state = "submitted";
      this.saveState();
    }

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
    extra.push(...(await this.judged(envelope)));
    const receipt = await this.finish(verifyRun(envelope, { policy: this.policy, mode: this.mode, now: this.now, extraResults: extra }));
    // Only settle an attempt that is still ours to settle.
    if (entry && firstSubmission && entry.state === "submitted") entry.state = receipt.evaluated_decision === "allow" ? "validated" : "rejected";
    this.saveState();
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
    const extraResults = await this.judged(envelope);
    return this.finish(verifyRun(envelope, { policy: this.policy, mode: this.mode, now: this.now, extraResults }));
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
      policy_digest: receipt.policy_digest,
      reviewer: reviewer.id,
      reason: reviewer.reason,
      issued_at: issued.toISOString(),
      expires_at: new Date(issued.getTime() + this.policy.enforcement.reviewTimeoutMs).toISOString(),
    });
    this.approvals.set(approval.approval_id, { approval, used: false });
    this.saveState();
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
    try {
      this.saveState();
    } catch (error) {
      // Not durably spent, so not redeemed: the caller must not release.
      record.used = false;
      throw error;
    }
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
    this.saveState();
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
    const compiled = this.policy.contracts.get(c.name);
    if (!compiled) return { reason: "CONTRACT_UNKNOWN", message: `Policy ${this.policy.id} no longer declares contract '${c.name}'.` };
    // A contract restored after a restart may predate a policy edit; its terms no longer hold.
    if (c.definition_digest !== compiled.definitionDigest) {
      return { reason: "CONTRACT_POLICY_CHANGED", message: `Contract '${c.name}' was issued under different obligations than the current policy defines.` };
    }
    const allowed = compiled.allowedTools;
    if (allowed !== "any" && !allowed.has(tool)) return { reason: "TOOL_NOT_ALLOWED", message: `'${tool}' is not in allowed_tools for ${c.name} (tools are denied by default).` };
    return undefined;
  }

  private async judged(envelope: RunEnvelope): Promise<RawResult[]> {
    return this.judge && this.policy.semantics.enabled ? judgeClaims(envelope, this.policy, this.judge) : [];
  }

  /** Persist before release. If a durable receipt cannot be written, protected release is blocked. */
  private async finish(evaluated: Receipt): Promise<Receipt> {
    let receipt = await this.persist(this.sign(evaluated));
    // A persistence failure amends (and re-seals) the receipt; sign the final version.
    if (!receipt.signature && this.signingKeyPem) receipt = this.sign(receipt);
    this.issuedReceipts.set(receipt.receipt_sha256, {
      receipt_sha256: receipt.receipt_sha256,
      run_id: receipt.run_id,
      output_sha256: receipt.output_sha256,
      policy_digest: receipt.policy.digest,
      evaluated_decision: receipt.evaluated_decision,
    });
    this.saveState();
    return receipt;
  }

  /** Tool events from every attempt of this entry's contract for its task: budgets span retries. */
  private taskToolEvents(entry: AttemptEntry): ToolEvent[] {
    return this.ledger
      .forTask(entry.contract.task_id)
      .filter((e) => e.contract.name === entry.contract.name)
      .flatMap((e) => e.toolEvents);
  }

  private saveState(): void {
    this.stateStore?.save({
      version: 1,
      attempts: this.ledger.entries(),
      approvals: [...this.approvals.values()],
      receipts: [...this.issuedReceipts.values()],
    });
  }

  private sign(receipt: Receipt): Receipt {
    return this.signingKeyPem ? signReceipt(receipt, this.signingKeyPem) : receipt;
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
