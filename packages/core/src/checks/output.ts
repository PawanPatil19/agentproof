/**
 * output.schema — the deliverable has the shape the contract (or the
 * final-answer policy) promised. Structural only: JSON Schema cannot tell
 * whether evidence IDs resolve; evidence.reference does that.
 */
import { describeErrors } from "../util/ajv.ts";
import { pass, result, type Check } from "./context.ts";

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
