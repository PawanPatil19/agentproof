import type { Check } from "./context.ts";
import type { CheckId } from "./ids.ts";
import { checkContractBinding, checkContractDeadline } from "./contract.ts";
import { checkFreshness, checkIntegrity, checkLocators, checkQuotes, checkReferences, checkSources } from "./evidence.ts";
import { checkNumeric } from "./numeric.ts";
import { checkClaimCoverage, checkOutputSchema } from "./output.ts";
import { checkTools } from "./tools.ts";

/**
 * Checks in evaluation order. Each decides for itself whether it applies
 * (for example, freshness runs only when the policy sets a max age), so
 * adding a check means writing one pure function and listing it here.
 */
export const CHECKS: ReadonlyArray<{ id: CheckId; run: Check }> = [
  { id: "contract.binding", run: checkContractBinding },
  { id: "contract.deadline", run: checkContractDeadline },
  { id: "output.schema", run: checkOutputSchema },
  { id: "output.claims", run: checkClaimCoverage },
  { id: "tools.permission", run: checkTools },
  { id: "evidence.reference", run: checkReferences },
  { id: "evidence.quote", run: checkQuotes },
  { id: "evidence.integrity", run: checkIntegrity },
  { id: "evidence.locator", run: checkLocators },
  { id: "evidence.source", run: checkSources },
  { id: "evidence.freshness", run: checkFreshness },
  { id: "numeric.fidelity", run: checkNumeric },
];

export * from "./context.ts";
export * from "./ids.ts";
