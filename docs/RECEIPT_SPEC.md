# AgentProof receipt format, v2

Status: **draft, stable for 0.x**. Identifier: `agentproof.receipt/v2`,
predicate type `https://agentproof.dev/receipt/v2`.

A receipt is the record of one gate decision: which policy ran, every check
result, the decision, and digests of what was checked. This document says
how to verify one **without AgentProof's code**. A verifier needs SHA-256,
HMAC-SHA256, Ed25519 and an RFC 8785 JSON canonicalizer, all of which exist
in every mainstream language.

Conformance vectors: [`spec/receipt-vectors.json`](spec/receipt-vectors.json).
An independent Python checker written from this document alone:
[`spec/verify_vectors.py`](spec/verify_vectors.py)
(`python3 docs/spec/verify_vectors.py`).

The key words MUST, MUST NOT and SHOULD are used as in RFC 2119.

## 1. Why these building blocks

| Need | Choice | Why |
| --- | --- | --- |
| Signed envelope | **DSSE** (Dead Simple Signing Envelope) | Signs bytes plus a type, so there is no canonicalization inside the signature check. Used by in-toto, SLSA and Sigstore, with verifiers in Go, Python, Java, Rust and JS. |
| Statement shape | **in-toto Attestation Statement v1** | A typed predicate about a subject digest. Existing attestation tooling (cosign, Rekor, policy engines) can store and route receipts without knowing what's inside. |
| Canonical JSON | **RFC 8785 (JCS)** | One exact byte form for a JSON value, specified independently of any language. |
| Signature | **Ed25519** | Deterministic, small, no parameter choices to get wrong. |
| Claim privacy | **HMAC-SHA256 commitments with per-claim salts** | Stops anyone from confirming a guessed claim, while letting the issuer open one claim to one auditor. |

COSE (RFC 9052) and W3C Verifiable Credentials were the alternatives. COSE
is CBOR, which most of AgentProof's users don't have tooling for. VCs bring
a data-model and identity layer AgentProof doesn't need yet. DSSE is the
smallest format that is already widely verified.

## 2. Canonical JSON

Every digest and the signed payload use RFC 8785:

- Object members sorted by key, comparing keys as sequences of **UTF-16 code
  units** (so `"\r"` < `"1"` < `"\u0080"` < `"€"` < `"😀"` < `"דּ"`).
- Numbers serialized as ECMAScript `Number.prototype.toString` does
  (`1e+30`, `0.002`, `1e-27`, `-0` → `0`).
- Strings escape only `"`, `\` and U+0000–U+001F (using `\b \t \n \f \r`
  where they exist, else lowercase `\u00XX`). Everything else is literal UTF-8.
- No insignificant whitespace.

Receipt strings MUST be valid Unicode (no lone surrogates); the issuer
replaces any it finds in agent-supplied text with U+FFFD before sealing.
Receipt numbers are integers or finite decimals.

## 3. The receipt object

A receipt is a JSON object. The authoritative field list is the JSON Schema
in [`packages/core/src/report/schema.ts`](../packages/core/src/report/schema.ts);
the fields a verifier relies on are:

| Field | Meaning |
| --- | --- |
| `receipt_version` | `"agentproof.receipt/v2"`. Verifiers MUST reject other values. |
| `run_id`, `task_id`, `boundary` | Which run and which gate. |
| `created_at` | ISO 8601 time the issuer evaluated the run (issuer's clock). |
| `policy` | `{ id, version, digest }`: the policy that decided. |
| `contract` | The contract instance for worker completions, when present. |
| `mode`, `decision`, `evaluated_decision`, `reason_codes` | The outcome. In `observe` mode `decision` is always `allow`. |
| `checks`, `coverage` | Every check result and the totals. |
| `claims[]` | `{ id, text_commitment, evidence_ids, status }`, plus redacted `text` only if the policy captures claims. |
| `evidence[]`, `tool_events[]` | IDs, sanitized locators, content digests, tool calls. |
| `output_sha256` | Hex SHA-256 of the canonical JSON of the output that was checked. |
| `receipt_sha256` | Seal, see §4. |
| `signature` | Optional inline signature, see §6. |

"Verified" means the run passed the recorded checks under the named policy.
It never means the output is true or safe.

## 4. Seal

```
receipt_sha256 = hex(SHA-256(JCS(receipt without "receipt_sha256" and "signature")))
```

The seal detects edits but not forgery (anyone can re-seal). The signature
covers it.

## 5. Claim commitments

A claim's text never appears as a plain hash. Each claim carries

```
salt            = HMAC-SHA256(key = K, msg = "agentproof.claim-salt/v1" || 0x00 || run_id || 0x00 || claim.id)
text_commitment = "hmac-sha256:" || hex(HMAC-SHA256(key = salt, msg = UTF-8(claim text)))
```

where `K` is a commitment key (at least 16 bytes, 32 recommended) that only
the issuer holds, `run_id` and `claim.id` are the UTF-8 values as they
appear in the receipt, and the claim text is exactly as the agent submitted
it (before redaction).

- Without `K`, the salt is unknown, so holding a receipt does not let anyone
  test whether a claim said "Revenue grew 12% in Q3".
- To open one claim, the issuer gives an auditor a **disclosure**:
  `{ "claim_id", "salt" (64 hex chars), "text" }`. The auditor recomputes
  `text_commitment` from `salt` and `text` and compares it with the signed
  receipt. A salt opens only its own claim.
- An issuer that does not configure `K` uses a random one per receipt; those
  commitments can never be opened.

## 6. Signature: DSSE over an in-toto Statement

The statement for a receipt `R` is:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "output", "digest": { "sha256": "<R.output_sha256>" } }],
  "predicateType": "https://agentproof.dev/receipt/v2",
  "predicate": "<R without the signature field, receipt_sha256 included>"
}
```

```
payloadType = "application/vnd.in-toto+json"
payload     = UTF-8(JCS(statement))
PAE         = "DSSEv1" SP len(payloadType) SP payloadType SP len(payload) SP payload
signature   = Ed25519(private key, PAE)
keyid       = first 16 hex chars of SHA-256(public key as SPKI DER)
```

(`len` is the byte length as ASCII decimal; SP is one space.)

A signed receipt is exchanged in either of two equivalent forms:

**Inline** (what AgentProof writes to `agentproof-reports/<run>.json`):
the receipt with
`"signature": { "alg": "ed25519", "key_id": keyid, "value": base64(signature) }`.

**DSSE envelope** (written to `<run>.dsse.json` by `check --sign-key`):

```json
{ "payloadType": "application/vnd.in-toto+json",
  "payload": "<base64(payload)>",
  "signatures": [{ "keyid": "<keyid>", "sig": "<base64(signature)>" }] }
```

Because the payload is canonical, one form converts to the other exactly.

## 7. Verifying

Given a trusted Ed25519 public key `P`:

**From a DSSE envelope**

1. `payloadType` MUST be `application/vnd.in-toto+json`; exactly one signature.
2. Ed25519-verify `sig` over `PAE(payloadType, base64decode(payload))` with `P`.
   `keyid` MUST equal the key ID of `P`.
3. Parse the payload. `_type` and `predicateType` MUST be as in §6.
4. The predicate MUST have `receipt_version` `agentproof.receipt/v2`, and
   `subject[0].digest.sha256` MUST equal `predicate.output_sha256`.
5. Recompute the seal (§4) over the predicate; it MUST equal
   `predicate.receipt_sha256`.

AgentProof's own verifier additionally requires the payload bytes to equal
`JCS(statement)`, so the envelope and inline forms can never disagree.

**From an inline receipt**: check `signature.alg` is `ed25519` and
`signature.key_id` is `P`'s key ID, recompute the seal (§4), rebuild the
payload from the receipt (§6) and Ed25519-verify `signature.value` over its
PAE.

The CLI does all of this: `agentproof verify-receipt <file> --public-key issuer.pub`
accepts either form.

## 8. Versioning

- Any change to the bytes a verifier computes (fields, canonicalization,
  commitment or signature rules) bumps the receipt version and predicate type
  (`/v3`), and regenerates the vectors.
- Adding an optional receipt field does not bump the version; verifiers MUST
  NOT reject unknown top-level fields (they are covered by the seal and
  signature like any other).
- v1 receipts (`agentproof.receipt/v1`: unsalted `text_sha256`, a signature
  over the digest string) are not accepted by v2 verifiers. AgentProof was
  pre-release when v2 replaced them.

## 9. Test vectors

[`spec/receipt-vectors.json`](spec/receipt-vectors.json) contains, from
fixed inputs (the RFC 8032 test key, a fixed commitment key and clock):

- `canonical_json`: inputs, their RFC 8785 form and SHA-256;
- `claim_commitments`: `(K, run_id, claim_id, text)` → salt and commitment;
- `receipt`: an unsigned receipt, its seal, canonical statement, PAE (hex),
  signature, the inline signed receipt, the DSSE envelope, and one claim
  disclosure.

An implementation conforms when it reproduces every value byte for byte and
verifies the signed receipt and envelope. The keys in the file are public
test keys: never use them for real receipts. Regenerate with
`npm run vectors` (only when the format version changes).
