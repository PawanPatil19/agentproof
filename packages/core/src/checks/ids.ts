/** Every check the engine can emit. Policies may only reference these IDs. */
export const CHECK_IDS = [
  "envelope.structure",
  "output.schema",
  "output.claims",
  "evidence.reference",
  "evidence.quote",
  "evidence.integrity",
  "evidence.locator",
  "evidence.source",
  "evidence.freshness",
  "numeric.fidelity",
  "claims.support",
  "tools.permission",
  "contract.binding",
  "contract.deadline",
  "contract.lifecycle",
  "receipt.persistence",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

/**
 * Checks that guard the verification boundary itself. They can never be made
 * advisory: demoting them would let a garbage envelope or a forged contract pass.
 */
export const INTEGRITY_CHECKS: ReadonlySet<CheckId> = new Set([
  "envelope.structure",
  "contract.binding",
  "contract.deadline",
  "contract.lifecycle",
  "tools.permission",
  "receipt.persistence",
]);

export function isCheckId(value: string): value is CheckId {
  return (CHECK_IDS as readonly string[]).includes(value);
}
