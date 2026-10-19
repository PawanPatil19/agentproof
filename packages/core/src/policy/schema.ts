/**
 * JSON Schema for `agentproof.yaml`. Every object is closed
 * (`additionalProperties: false`) so unknown or misspelt keys are rejected.
 */
const decision = { enum: ["allow", "block", "review"] };
const idList = { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true };

export const POLICY_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["api_version", "policy"],
  properties: {
    api_version: { const: "agentproof/v1" },
    policy: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version"],
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
        version: { type: "integer", minimum: 1 },
        description: { type: "string" },
      },
    },
    mode: { enum: ["observe", "enforce"] },
    privacy: {
      type: "object",
      additionalProperties: false,
      properties: {
        capture: { enum: ["hashes", "claims"] },
        retention_days: { type: "integer", minimum: 1 },
      },
    },
    registry: {
      type: "object",
      additionalProperties: false,
      properties: { sources: idList, tools: idList },
    },
    checks: {
      type: "object",
      additionalProperties: false,
      properties: {
        evidence: {
          type: "object",
          additionalProperties: false,
          properties: {
            min_claims: { type: "integer", minimum: 0 },
            require_evidence_for_each_claim: { type: "boolean" },
            require_quote: { type: "boolean" },
            min_quote_chars: { type: "integer", minimum: 1 },
            verify_content_hash: { type: "boolean" },
            allowed_source_ids: { ...idList, minItems: 1 },
            max_source_age_days: { type: "number", exclusiveMinimum: 0 },
          },
        },
        numeric: {
          type: "object",
          additionalProperties: false,
          properties: {
            absolute_tolerance: { type: "number", minimum: 0 },
            relative_tolerance: { type: "number", minimum: 0 },
          },
        },
      },
    },
    final_answer: {
      type: "object",
      additionalProperties: false,
      properties: { output_schema: { type: "object" } },
    },
    contracts: {
      type: "object",
      propertyNames: { pattern: "^[a-z0-9][a-z0-9_-]*$" },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["version", "coordinator", "worker", "deadline_ms"],
        properties: {
          version: { type: "integer", minimum: 1 },
          description: { type: "string" },
          coordinator: { type: "string", minLength: 1 },
          worker: { type: "string", minLength: 1 },
          deadline_ms: { type: "integer", minimum: 1 },
          allowed_tools: idList,
          output_schema: { type: "object" },
        },
      },
    },
    enforcement: {
      type: "object",
      additionalProperties: false,
      properties: {
        on_required_check_fail: decision,
        on_required_check_unknown: decision,
        // A crashed check must never allow; observe mode already lets work continue.
        on_verifier_error: { enum: ["block", "review"] },
        advisory_checks: idList,
        review_timeout_ms: { type: "integer", minimum: 1 },
        max_repair_attempts: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;
