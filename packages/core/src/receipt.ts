/**
 * Receipts: the portable record of why a boundary was allowed, blocked or
 * sent to review. Metadata-only by default — evidence bodies never appear,
 * claim text appears only when `privacy.capture: claims`, URLs lose their
 * query strings, and known secret formats are redacted.
 */
import type {
  Boundary,
  CheckResult,
  CheckStatus,
  ContractInstance,
  Coverage,
  Decision,
  EvidenceRecord,
  Mode,
  Receipt,
  ReceiptClaim,
  ReceiptEvidence,
  ReasonCode,
  ToolEvent,
} from "./types.ts";
import type { CompiledPolicy } from "./policy/compile.ts";
import type { ResolvedClaim } from "./checks/context.ts";
import { decide } from "./decide.ts";
import { canonicalJson, sha256 } from "./util/hash.ts";
import { claimSalt, commitClaimText, commitmentKeyBytes, generateCommitmentKey, generateCommitmentNonce, type CommitmentKey } from "./commitment.ts";
import { redact, safeText, sanitizeLocator, wellFormed, wellFormedDeep } from "./util/text.ts";
import { CHECKER_VERSION, RECEIPT_VERSION } from "./version.ts";

export interface ReceiptInput {
  runId: string;
  taskId?: string;
  boundary: Boundary;
  policy: CompiledPolicy;
  mode: Mode;
  results: CheckResult[];
  claims: ResolvedClaim[];
  evidence: EvidenceRecord[];
  toolEvents: ToolEvent[];
  contract?: ContractInstance;
  output: unknown;
  createdAt: Date;
  durationMs: number;
  /**
   * Secret key from which per-claim salts are derived (see commitment.ts).
   * Keep it to open claims to an auditor later; omitted, a random key is
   * used and the claim commitments can never be opened.
   */
  commitmentKey?: CommitmentKey;
  /**
   * Per-receipt nonce for claim salts. Leave unset: a fresh random one is
   * used. Only fixed in conformance vectors; reusing a nonce under one key
   * lets a disclosure for one receipt open claims in another.
   */
  commitmentNonce?: string;
}

/** Fold per-claim results into one status: fail > unknown > pass > not_applicable. */
function claimStatus(claimId: string, results: CheckResult[]): CheckStatus {
  const mine = results.filter((r) => r.required && r.target === `claim:${claimId}`).map((r) => r.status);
  if (mine.includes("fail")) return "fail";
  if (mine.includes("unknown")) return "unknown";
  if (mine.includes("pass")) return "pass";
  return "not_applicable";
}

function coverageOf(claims: ReceiptClaim[], results: CheckResult[], toolEvents: number): Coverage {
  const checks: Record<CheckStatus, number> = { pass: 0, fail: 0, unknown: 0, not_applicable: 0 };
  for (const r of results) checks[r.status] += 1;
  return {
    claims_total: claims.length,
    claims_with_evidence: claims.filter((c) => c.evidence_ids.length > 0).length,
    claims_passing: claims.filter((c) => c.status === "pass").length,
    checks,
    tool_events: toolEvents,
  };
}

export function hashOutput(output: unknown): string {
  return sha256(canonicalJson(output ?? null));
}

export function buildReceipt(input: ReceiptInput): Receipt {
  const { policy, results } = input;
  const { decision: evaluated, reasons } = decide(results, policy);
  const includeText = policy.privacy.capture === "claims";
  // Decode once, up front: a bad key fails the same way whether or not the run has claims.
  const commitmentKey = commitmentKeyBytes(input.commitmentKey ?? generateCommitmentKey());
  const commitmentNonce = input.commitmentNonce ?? generateCommitmentNonce();

  // Everything below that the agent controls is redacted and capped: IDs,
  // messages and targets can carry secrets as easily as claim text can.
  const claims: ReceiptClaim[] = input.claims.map((c) => {
    const id = safeText(c.id, 128);
    return {
      id,
      // Salted, so a short claim can't be confirmed by hashing guesses.
      text_commitment: commitClaimText(claimSalt(commitmentKey, commitmentNonce, id), c.text),
      ...(includeText ? { text: wellFormed(redact(c.text)) } : {}),
      evidence_ids: c.evidence_ids.map((e) => safeText(e, 128)),
      status: claimStatus(c.id, results),
    };
  });

  const evidence: ReceiptEvidence[] = input.evidence.map((e) => ({
    id: safeText(e.id, 128),
    source_id: e.source_id === undefined ? undefined : safeText(e.source_id, 128),
    locator: e.locator === undefined ? undefined : sanitizeLocator(e.locator),
    content_sha256: e.content !== undefined ? sha256(e.content) : e.content_sha256?.replace(/^sha256:/, ""),
    published_at: e.published_at === undefined ? undefined : safeText(e.published_at, 64),
    revision: e.revision === undefined ? undefined : safeText(e.revision, 128),
  }));

  const c = input.contract;
  const receipt: Omit<Receipt, "receipt_sha256"> = {
    receipt_version: RECEIPT_VERSION,
    run_id: input.runId,
    task_id: input.taskId ?? c?.task_id,
    boundary: input.boundary,
    created_at: input.createdAt.toISOString(),
    duration_ms: Math.round(input.durationMs * 1000) / 1000,
    checker_version: CHECKER_VERSION,
    policy: { id: policy.id, version: policy.version, digest: policy.digest },
    contract: c && {
      name: c.name,
      version: c.version,
      digest: c.digest,
      attempt_id: c.attempt_id,
      attempt: c.attempt,
      parent_attempt_id: c.parent_attempt_id,
      worker: c.worker,
      coordinator: c.coordinator,
    },
    mode: input.mode,
    decision: input.mode === "enforce" ? evaluated : "allow",
    evaluated_decision: evaluated,
    reason_codes: reasons,
    coverage: coverageOf(claims, results, input.toolEvents.length),
    checks: results.map((r) => ({ ...r, target: safeText(r.target, 160), message: safeText(r.message) })),
    commitment_nonce: commitmentNonce,
    claims,
    evidence,
    tool_events: input.toolEvents.map((t) => ({
      ...t,
      tool: safeText(t.tool, 128),
      agent: safeText(t.agent, 128),
      reason: t.reason === undefined ? undefined : safeText(t.reason),
    })),
    output_sha256: hashOutput(input.output),
  };
  // Agent-supplied strings (run_id, task_id, contract fields, timestamps…) can
  // carry lone surrogates; make every string valid Unicode so the receipt is
  // canonicalizable, and verifiable, in any language.
  return seal(wellFormedDeep(receipt));
}

/** Compute the receipt digest over its canonical JSON (excluding the digest itself). */
export function seal(receipt: Omit<Receipt, "receipt_sha256"> | Receipt): Receipt {
  // A signature is attached after sealing and is never part of the digest;
  // re-sealing drops it, because the old signature no longer applies.
  const { receipt_sha256: _digest, signature: _signature, ...body } = receipt as Receipt;
  return { ...body, receipt_sha256: sha256(canonicalJson(body)) };
}

/** True when the receipt has not been edited since it was sealed. Not tamper-proof: an attacker can re-seal. */
export function verifyReceiptDigest(receipt: Receipt): boolean {
  return seal(receipt).receipt_sha256 === receipt.receipt_sha256;
}

/**
 * Append runtime results (e.g. lifecycle or persistence failures found after
 * evaluation), re-decide and re-seal. Used by the SDK, never to weaken a result.
 */
export function amendReceipt(receipt: Receipt, extra: CheckResult[], policy: CompiledPolicy): Receipt {
  const checks = [...receipt.checks, ...extra];
  const { decision: evaluated, reasons } = decide(checks, policy);
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, unknown: 0, not_applicable: 0 };
  for (const r of checks) counts[r.status] += 1;
  const decision: Decision = receipt.mode === "enforce" ? evaluated : "allow";
  return seal({
    ...receipt,
    checks,
    evaluated_decision: evaluated,
    decision,
    reason_codes: reasons as ReasonCode[],
    coverage: { ...receipt.coverage, checks: counts },
  });
}
