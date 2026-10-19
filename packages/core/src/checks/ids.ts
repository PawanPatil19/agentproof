/** Every check the engine can emit. Policies may only reference these IDs. */
export const CHECK_IDS = [
  "envelope.structure",
  "output.schema",
  "evidence.reference",
  "evidence.quote",
  "evidence.integrity",
  "evidence.locator",
  "evidence.source",
  "evidence.freshness",
  "numeric.fidelity",
  "tools.permission",
  "contract.binding",
  "contract.deadline",
  "contract.lifecycle",
  "receipt.persistence",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export function isCheckId(value: string): value is CheckId {
  return (CHECK_IDS as readonly string[]).includes(value);
}
