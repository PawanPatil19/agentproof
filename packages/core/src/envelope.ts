/**
 * Validation and normalization of the run envelope — the one input format
 * shared by the SDK, the CLI and stored `run.json` files.
 */
import type { RunEnvelope } from "./types.ts";
import type { ResolvedClaim } from "./checks/context.ts";
import { createAjv, describeErrors } from "./util/ajv.ts";

const str = { type: "string" };
const nonEmpty = { type: "string", minLength: 1 };
/**
 * Identifiers the agent controls end up in receipts and reports, so they are
 * short and plain: no spaces, quotes, angle brackets or control characters.
 */
const ident = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:/@#+-]{0,127}$" };
const valueKey = { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" };
const unit = { type: "string", maxLength: 32, pattern: "^[^<>\"'`\\u0000-\\u001f]*$" };

const ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["api_version", "run_id", "output"],
  properties: {
    api_version: { const: "agentproof/v1" },
    run_id: { type: "string", minLength: 1, maxLength: 200 },
    task_id: nonEmpty,
    boundary: { enum: ["worker_completion", "final_answer"] },
    output: {},
    submitted_at: { type: "string", format: "date-time" },
    metadata: { type: "object" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: ident,
          source_id: ident,
          locator: str,
          content: str,
          content_sha256: { type: "string", pattern: "^(sha256:)?[0-9a-fA-F]{64}$" },
          published_at: str,
          revision: str,
          captured_at: str,
          values: {
            type: "object",
            propertyNames: valueKey,
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              required: ["value"],
              properties: { value: { type: "number" }, unit },
            },
          },
        },
      },
    },
    tool_events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "agent"],
        properties: {
          tool: ident,
          agent: ident,
          at: str,
          outcome: { enum: ["invoked", "blocked"] },
          reason: { type: "string", maxLength: 500 },
          reason_code: { type: "string", pattern: "^[A-Z_]{2,40}$" },
          amount: { type: "number", minimum: 0 },
          consumed: {
            type: "object",
            additionalProperties: false,
            required: ["calls"],
            properties: { calls: { type: "integer", minimum: 0 }, total: { type: "number", minimum: 0 } },
          },
        },
      },
    },
    contract: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version", "definition_digest", "digest", "task_id", "attempt_id", "attempt", "coordinator", "worker", "issued_at", "deadline_at"],
      properties: {
        name: nonEmpty,
        version: { type: "integer", minimum: 1 },
        definition_digest: nonEmpty,
        digest: nonEmpty,
        task_id: nonEmpty,
        attempt_id: nonEmpty,
        attempt: { type: "integer", minimum: 1 },
        parent_attempt_id: nonEmpty,
        coordinator: nonEmpty,
        worker: nonEmpty,
        issued_at: str,
        deadline_at: str,
        acceptance: {
          type: "object",
          additionalProperties: false,
          required: ["identity", "digest", "at"],
          properties: { identity: nonEmpty, digest: nonEmpty, at: str },
        },
      },
    },
  },
};

/** Claims are read from `output.claims`. Extra fields are allowed; the output schema governs them. */
const CLAIMS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["text"],
    properties: {
      id: ident,
      text: str,
      quote: str,
      evidence_ids: { type: "array", items: ident },
      value: {
        type: "object",
        required: ["key", "value"],
        properties: { key: valueKey, value: { type: "number" }, unit },
      },
    },
  },
};

const ajv = createAjv();
const validateEnvelope = ajv.compile(ENVELOPE_SCHEMA);
const validateClaims = ajv.compile(CLAIMS_SCHEMA);

export type EnvelopeParse =
  | { ok: true; envelope: RunEnvelope; claims: ResolvedClaim[] }
  | { ok: false; problems: string };

export function parseEnvelope(input: unknown): EnvelopeParse {
  if (!validateEnvelope(input)) {
    return { ok: false, problems: describeErrors(validateEnvelope.errors, 5) };
  }
  const envelope = input as unknown as RunEnvelope;

  // A contract only means something at a worker boundary; anything else would skip its checks.
  if (envelope.contract && envelope.boundary === "final_answer") {
    return { ok: false, problems: "a contract was supplied with boundary 'final_answer'; contracts are verified at 'worker_completion'" };
  }

  const seen = new Set<string>();
  for (const record of envelope.evidence ?? []) {
    if (seen.has(record.id)) return { ok: false, problems: `duplicate evidence id '${record.id}'` };
    seen.add(record.id);
  }

  const output = envelope.output;
  const rawClaims =
    output !== null && typeof output === "object" && !Array.isArray(output) ? (output as { claims?: unknown }).claims : undefined;
  if (rawClaims === undefined) return { ok: true, envelope, claims: [] };
  if (!validateClaims(rawClaims)) {
    return { ok: false, problems: `output.claims: ${describeErrors(validateClaims.errors, 5)}` };
  }

  const claims = (rawClaims as ResolvedClaim[]).map((claim, i) => ({
    ...claim,
    id: claim.id ?? `c${i + 1}`,
    evidence_ids: claim.evidence_ids ?? [],
  }));
  const ids = new Set<string>();
  for (const claim of claims) {
    if (ids.has(claim.id)) return { ok: false, problems: `duplicate claim id '${claim.id}'` };
    ids.add(claim.id);
  }
  return { ok: true, envelope, claims };
}
