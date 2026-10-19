/**
 * Shape check for receipts read back from disk. A receipt file is untrusted
 * input to `agentproof report`: enums and numbers are validated here, and the
 * renderer escapes every string on top of that.
 */
import type { Receipt } from "../types.ts";
import { createAjv, describeErrors } from "../util/ajv.ts";

const status = { enum: ["pass", "fail", "unknown", "not_applicable"] };
const decision = { enum: ["allow", "block", "review"] };
const str = { type: "string", maxLength: 2000 };
const count = { type: "integer", minimum: 0 };

const RECEIPT_SCHEMA = {
  type: "object",
  required: [
    "receipt_version", "run_id", "boundary", "created_at", "duration_ms", "checker_version", "policy", "mode",
    "decision", "evaluated_decision", "reason_codes", "coverage", "checks", "claims", "evidence", "tool_events",
    "output_sha256", "receipt_sha256", "commitment_nonce",
  ],
  properties: {
    receipt_version: { const: "agentproof.receipt/v2" },
    run_id: str,
    task_id: str,
    boundary: { enum: ["worker_completion", "final_answer"] },
    created_at: str,
    duration_ms: { type: "number", minimum: 0 },
    checker_version: str,
    policy: { type: "object", required: ["id", "version", "digest"], properties: { id: str, version: count, digest: str } },
    contract: {
      type: "object",
      required: ["name", "version", "digest", "attempt_id", "attempt", "worker", "coordinator"],
      properties: { name: str, version: count, digest: str, attempt_id: str, attempt: count, parent_attempt_id: str, worker: str, coordinator: str },
    },
    mode: { enum: ["observe", "enforce"] },
    decision,
    evaluated_decision: decision,
    reason_codes: { type: "array", items: { type: "string", pattern: "^[A-Z_]{2,40}$" } },
    coverage: {
      type: "object",
      required: ["claims_total", "claims_with_evidence", "claims_passing", "checks", "tool_events"],
      properties: {
        claims_total: count,
        claims_with_evidence: count,
        claims_passing: count,
        tool_events: count,
        checks: { type: "object", required: ["pass", "fail", "unknown", "not_applicable"], properties: { pass: count, fail: count, unknown: count, not_applicable: count } },
      },
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["check", "kind", "target", "status", "reason", "message", "required"],
        properties: { check: str, kind: { enum: ["deterministic", "probabilistic"] }, target: str, status, reason: str, message: str, required: { type: "boolean" } },
      },
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "text_commitment", "evidence_ids", "status"],
        properties: { id: str, text_commitment: { type: "string", pattern: "^hmac-sha256:[0-9a-f]{64}$" }, text: { type: "string" }, evidence_ids: { type: "array", items: str }, status },
      },
    },
    evidence: { type: "array", items: { type: "object", required: ["id"], properties: { id: str, source_id: str, locator: str, content_sha256: str, published_at: str, revision: str } } },
    tool_events: {
      type: "array",
      items: { type: "object", required: ["tool", "agent"], properties: { tool: str, agent: str, at: str, outcome: { enum: ["invoked", "blocked"] }, reason: str, reason_code: str } },
    },
    output_sha256: str,
    receipt_sha256: str,
    commitment_nonce: { type: "string", pattern: "^[0-9a-f]{32}$" },
    signature: {
      type: "object",
      required: ["alg", "key_id", "value"],
      properties: { alg: { const: "ed25519" }, key_id: { type: "string", pattern: "^[0-9a-f]{16}$" }, value: { type: "string", pattern: "^[A-Za-z0-9+/]{85}[AQgw]==$" } },
      additionalProperties: false,
    },
  },
};

const validate = createAjv().compile(RECEIPT_SCHEMA);

export type ReceiptParse = { ok: true; receipt: Receipt } | { ok: false; problems: string };

export function parseReceipt(input: unknown): ReceiptParse {
  return validate(input) ? { ok: true, receipt: input as unknown as Receipt } : { ok: false, problems: describeErrors(validate.errors, 5) };
}
