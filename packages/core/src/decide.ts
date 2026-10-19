/**
 * Turn check results into an action. One rule for every check:
 *
 *   required fail     → enforcement.on_required_check_fail     (default block)
 *   required unknown  → enforcement.on_required_check_unknown  (default review)
 *   checker crashed   → enforcement.on_verifier_error          (default block)
 *   advisory checks   → shown, never decide anything
 *
 * The most severe outcome wins: block > review > allow.
 */
import type { CheckResult, Decision, ReasonCode } from "./types.ts";
import type { CompiledPolicy } from "./policy/compile.ts";
import type { RawResult } from "./checks/context.ts";
import { isCheckId } from "./checks/ids.ts";

const SEVERITY: Record<Decision, number> = { allow: 0, review: 1, block: 2 };

export function markRequired(results: RawResult[], policy: CompiledPolicy): CheckResult[] {
  return results.map((r) => ({ ...r, required: !(isCheckId(r.check) && policy.enforcement.advisory.has(r.check)) }));
}

export function decide(results: CheckResult[], policy: CompiledPolicy): { decision: Decision; reasons: ReasonCode[] } {
  let decision: Decision = "allow";
  const reasons = new Set<ReasonCode>();
  for (const r of results) {
    if (!r.required) continue;
    let outcome: Decision | undefined;
    if (r.reason === "CHECKER_ERROR") outcome = policy.enforcement.onVerifierError;
    else if (r.status === "fail") outcome = policy.enforcement.onFail;
    else if (r.status === "unknown") outcome = policy.enforcement.onUnknown;
    if (outcome === undefined) continue;
    if (outcome !== "allow") reasons.add(r.reason);
    if (SEVERITY[outcome] > SEVERITY[decision]) decision = outcome;
  }
  return { decision, reasons: [...reasons] };
}
