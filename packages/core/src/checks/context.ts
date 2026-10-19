import type { Boundary, CheckResult, CheckStatus, Claim, EvidenceRecord, ReasonCode, RunEnvelope } from "../types.ts";
import type { CompiledPolicy } from "../policy/compile.ts";
import type { CheckId } from "./ids.ts";

/** A claim after normalization: it always has an ID and an evidence list. */
export interface ResolvedClaim extends Claim {
  id: string;
  evidence_ids: string[];
}

/** Everything a check may read. Checks are pure functions of this context. */
export interface CheckContext {
  envelope: RunEnvelope;
  boundary: Boundary;
  policy: CompiledPolicy;
  claims: ResolvedClaim[];
  evidence: ReadonlyMap<string, EvidenceRecord>;
  /** Records cited by at least one claim; all records when no claim cites any. */
  cited: EvidenceRecord[];
  /** Reference time for freshness and deadlines: `submitted_at`, else the verifier clock. */
  referenceTime: Date;
}

/** A check result before the engine decides whether it is required. */
export type RawResult = Omit<CheckResult, "required">;

export type Check = (ctx: CheckContext) => RawResult[];

export function result(
  check: CheckId,
  target: string,
  status: CheckStatus,
  reason: ReasonCode,
  message: string,
): RawResult {
  return { check, kind: "deterministic", target, status, reason, message };
}

export const pass = (check: CheckId, target: string, message: string) => result(check, target, "pass", "OK", message);

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
