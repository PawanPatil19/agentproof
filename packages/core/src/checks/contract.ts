/**
 * Contract checks: the deliverable answers the exact contract that was
 * issued and accepted, by the bound worker, before the deadline.
 *
 * Inside a single trusted host these give integrity and replay protection,
 * not authentication. Cross-boundary identity needs signed contracts.
 */
import { contractInstanceDigest } from "../contract.ts";
import { pass, result, type Check, type RawResult } from "./context.ts";

/** contract.binding — contract present, pinned to the current policy, untampered, accepted by the bound worker. */
export const checkContractBinding: Check = (ctx) => {
  if (ctx.boundary !== "worker_completion" || ctx.policy.contracts.size === 0) return [];
  const contract = ctx.envelope.contract;
  const fail = (reason: RawResult["reason"], message: string) => [result("contract.binding", "contract", "fail", reason, message)];

  if (!contract) return fail("CONTRACT_MISSING", "Worker completion has no contract; the policy declares contracts for handoffs.");
  const compiled = ctx.policy.contracts.get(contract.name);
  if (!compiled) return fail("CONTRACT_UNKNOWN", `Contract '${contract.name}' is not declared in policy ${ctx.policy.id}@${ctx.policy.version}.`);
  if (contract.version !== compiled.definition.version || contract.definition_digest !== compiled.definitionDigest) {
    return fail("CONTRACT_POLICY_CHANGED", `Contract '${contract.name}' was issued under different obligations than the current policy defines.`);
  }
  if (contractInstanceDigest(contract) !== contract.digest) {
    return fail("CONTRACT_DIGEST_MISMATCH", "Contract terms were altered after issue; the instance digest no longer matches.");
  }
  if (!contract.acceptance) return fail("CONTRACT_NOT_ACCEPTED", "The worker never accepted this contract.");
  if (contract.acceptance.digest !== contract.digest) {
    return fail("CONTRACT_DIGEST_MISMATCH", "The worker accepted a different contract digest than the one being completed.");
  }
  if (contract.acceptance.identity !== contract.worker) {
    return fail("CONTRACT_IDENTITY_MISMATCH", "The contract was accepted by an identity other than the bound worker.");
  }
  return [pass("contract.binding", "contract", `Accepted ${contract.name}@${contract.version}, attempt ${contract.attempt}, digest pinned.`)];
};

/** contract.deadline — submitted before the contract's deadline. */
export const checkContractDeadline: Check = (ctx) => {
  const contract = ctx.envelope.contract;
  if (ctx.boundary !== "worker_completion" || !contract) return [];
  const deadline = Date.parse(contract.deadline_at);
  if (Number.isNaN(deadline)) return [result("contract.deadline", "contract", "unknown", "CONTRACT_STATE_INVALID", "Contract deadline is not a valid timestamp.")];
  const lateMs = ctx.referenceTime.getTime() - deadline;
  return lateMs > 0
    ? [result("contract.deadline", "contract", "fail", "CONTRACT_EXPIRED", `Submitted ${lateMs} ms after the deadline.`)]
    : [pass("contract.deadline", "contract", `Submitted ${-lateMs} ms before the deadline.`)];
};
