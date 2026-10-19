/**
 * numeric.fidelity — an explicit numeric claim matches the structured value
 * captured in its evidence, in the same unit, within tolerance.
 *
 * Messages report relative differences, never the raw values, so receipts
 * do not leak figures the privacy policy keeps out.
 */
import { pass, result, type Check, type RawResult } from "./context.ts";

const normalizeUnit = (unit: string | undefined) => (unit ?? "").trim().toLowerCase();

export const checkNumeric: Check = (ctx) =>
  ctx.claims.flatMap((claim): RawResult[] => {
    if (!claim.value) return [];
    const target = `claim:${claim.id}`;
    const { key, value, unit } = claim.value;
    const source = claim.evidence_ids
      .map((id) => ctx.evidence.get(id))
      .find((record) => record?.values?.[key] !== undefined);
    const recorded = source?.values?.[key];
    if (!source || !recorded) {
      return [result("numeric.fidelity", target, "unknown", "NUMERIC_VALUE_MISSING", `No cited evidence records a value for '${key}'.`)];
    }
    if (normalizeUnit(unit) !== normalizeUnit(recorded.unit)) {
      return [
        result("numeric.fidelity", target, "fail", "NUMERIC_UNIT_MISMATCH", `Unit for '${key}' differs from ${source.id} ('${unit ?? "none"}' vs '${recorded.unit ?? "none"}').`),
      ];
    }
    const { absoluteTolerance, relativeTolerance } = ctx.policy.numeric;
    const tolerance = Math.max(absoluteTolerance, relativeTolerance * Math.abs(recorded.value));
    const diff = Math.abs(value - recorded.value);
    if (diff <= tolerance + Number.EPSILON) {
      return [pass("numeric.fidelity", target, `'${key}' matches ${source.id} within tolerance.`)];
    }
    const relative = recorded.value === 0 ? "∞" : `${((diff / Math.abs(recorded.value)) * 100).toFixed(1)}%`;
    return [result("numeric.fidelity", target, "fail", "NUMERIC_MISMATCH", `'${key}' differs from ${source.id} by ${relative}, beyond the allowed tolerance.`)];
  });
