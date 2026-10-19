/**
 * Salted claim commitments. A receipt never carries a plain hash of claim
 * text: claims are short and predictable ("Revenue grew 12% in Q3"), so
 * anyone holding the receipt could hash likely sentences and confirm a
 * match. Instead each claim carries
 *
 *   text_commitment = "hmac-sha256:" + hex(HMAC-SHA256(key = salt, msg = UTF-8 text))
 *
 * with a 32-byte salt per claim that never appears in the receipt. The
 * salt is derived from a commitment key the issuer keeps:
 *
 *   salt = HMAC-SHA256(key = commitment key, msg = "agentproof.claim-salt/v1" 0x00 run_id 0x00 claim_id)
 *
 * so the issuer can later open one claim to one auditor by handing over
 * (claim_id, salt, text). Opening one claim reveals nothing about the
 * others. Without a commitment key the engine uses a fresh random key per
 * receipt, and the claims can never be opened (fine when nobody needs to).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Receipt } from "./types.ts";

export const COMMITMENT_PREFIX = "hmac-sha256:";
const SALT_LABEL = "agentproof.claim-salt/v1";

/** Key material accepted for a commitment key: raw bytes, or a hex/base64 string of at least 16 bytes. */
export type CommitmentKey = Uint8Array | string;

/** A fresh random 32-byte commitment key, hex encoded. Store it as a secret alongside your signing key. */
export function generateCommitmentKey(): string {
  return randomBytes(32).toString("hex");
}

export function commitmentKeyBytes(key: CommitmentKey): Buffer {
  let bytes: Buffer;
  if (typeof key !== "string") bytes = Buffer.from(key);
  else {
    const text = key.trim();
    bytes = /^(?:[0-9a-fA-F]{2})+$/.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  }
  if (bytes.length < 16) throw new Error("A commitment key must be at least 16 bytes (32 recommended).");
  return bytes;
}

/** Derive the salt for one claim of one run. */
export function claimSalt(key: CommitmentKey, runId: string, claimId: string): Buffer {
  return createHmac("sha256", commitmentKeyBytes(key))
    .update(Buffer.concat([Buffer.from(SALT_LABEL, "utf8"), Buffer.of(0), Buffer.from(runId, "utf8"), Buffer.of(0), Buffer.from(claimId, "utf8")]))
    .digest();
}

/** Commit to claim text under a salt. */
export function commitClaimText(salt: Uint8Array, text: string): string {
  return COMMITMENT_PREFIX + createHmac("sha256", salt).update(text, "utf8").digest("hex");
}

/** What an issuer hands an auditor to open one claim. */
export interface ClaimDisclosure {
  claim_id: string;
  /** The claim's salt, hex encoded (32 bytes). */
  salt: string;
  text: string;
}

/**
 * Open one claim of a receipt for an auditor. Throws if the receipt has no
 * such claim or the text does not match its commitment under this key (the
 * wrong key or the wrong text), so an issuer can't disclose a mismatch by
 * accident.
 */
export function discloseClaim(key: CommitmentKey, receipt: Receipt, claimId: string, text: string): ClaimDisclosure {
  const salt = claimSalt(key, receipt.run_id, claimId);
  const disclosure = { claim_id: claimId, salt: salt.toString("hex"), text };
  if (!verifyClaimDisclosure(receipt, disclosure)) {
    throw new Error(`Claim '${claimId}' does not match its commitment under this key and text.`);
  }
  return disclosure;
}

/** True when the disclosed text and salt open the named claim's commitment. */
export function verifyClaimDisclosure(receipt: Receipt, disclosure: ClaimDisclosure): boolean {
  const claim = receipt.claims.find((c) => c.id === disclosure.claim_id);
  if (!claim || !/^[0-9a-f]{64}$/.test(disclosure.salt)) return false;
  const expected = Buffer.from(commitClaimText(Buffer.from(disclosure.salt, "hex"), disclosure.text), "utf8");
  const actual = Buffer.from(claim.text_commitment, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
