import type { ContractInstance } from "./types.ts";
import { digestOf } from "./util/hash.ts";

/** The fields a contract instance digest covers. Acceptance is excluded: it signs the digest. */
export type ContractTerms = Omit<ContractInstance, "digest" | "acceptance">;

/**
 * Digest binding the pinned definition to one task, attempt, pair of
 * identities and deadline. Changing any of them yields a different digest,
 * so an accepted contract cannot be silently re-scoped.
 */
export function contractInstanceDigest(terms: ContractTerms): string {
  return digestOf({
    name: terms.name,
    version: terms.version,
    definition_digest: terms.definition_digest,
    task_id: terms.task_id,
    attempt_id: terms.attempt_id,
    attempt: terms.attempt,
    parent_attempt_id: terms.parent_attempt_id,
    coordinator: terms.coordinator,
    worker: terms.worker,
    issued_at: terms.issued_at,
    deadline_at: terms.deadline_at,
  });
}
