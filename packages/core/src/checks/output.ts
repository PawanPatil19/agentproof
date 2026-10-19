/**
 * output.schema — the deliverable has the shape the contract (or the
 * final-answer policy) promised. Structural only: JSON Schema cannot tell
 * whether evidence IDs resolve; evidence.reference does that.
 */
import { describeErrors } from "../util/ajv.ts";
import { pass, result, type Check } from "./context.ts";

/**
 * output.claims — the output declares at least `min_claims` claims. Without
 * this, an answer that cites nothing would pass with zero checks run.
 */
export const checkClaimCoverage: Check = (ctx) => {
  const min = ctx.policy.evidence.minClaims;
  if (min === 0) return [];
  const n = ctx.claims.length;
  return n >= min
    ? [pass("output.claims", "output", `${n} claim${n === 1 ? "" : "s"} declared (minimum ${min}).`)]
    : [result("output.claims", "output", "fail", "CLAIMS_MISSING", `Output declares ${n} claim${n === 1 ? "" : "s"} in output.claims; the policy requires at least ${min}. Nothing can be verified without them.`)];
};

export const checkOutputSchema: Check = (ctx) => {
  const validate =
    ctx.boundary === "worker_completion"
      ? ctx.envelope.contract && ctx.policy.contracts.get(ctx.envelope.contract.name)?.validateOutput
      : ctx.policy.finalAnswerSchema;
  if (!validate) return [];
  return validate(ctx.envelope.output)
    ? [pass("output.schema", "output", "Output matches the declared schema.")]
    : [result("output.schema", "output", "fail", "SCHEMA_INVALID", `Output does not match the declared schema: ${describeErrors(validate.errors)}.`)];
};
