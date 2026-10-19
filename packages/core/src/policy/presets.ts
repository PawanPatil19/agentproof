import { compilePolicy, parsePolicy, type CompiledPolicy, type PolicyDocument } from "./compile.ts";

/**
 * The bundled diagnostic preset used when no policy file exists.
 * Observe mode, offline, deterministic only: it reports problems but never blocks.
 */
export const BASELINE_POLICY: PolicyDocument = {
  api_version: "agentproof/v1",
  policy: { id: "baseline", version: 1, description: "Bundled diagnostics. Observe only." },
  mode: "observe",
  privacy: { capture: "hashes", retention_days: 7 },
  checks: {
    evidence: { require_evidence_for_each_claim: true, require_quote: false, verify_content_hash: true },
  },
};

export function baselinePolicy(): CompiledPolicy {
  return compilePolicy(BASELINE_POLICY);
}

/** Starter policy written by `agentproof init --template research-handoff`. */
export const RESEARCH_HANDOFF_TEMPLATE = `# AgentProof policy — research → writer handoff.
# Review every line before switching mode to "enforce".
api_version: agentproof/v1
policy:
  id: research-handoff
  version: 1
  description: A researcher hands quoted, sourced claims to a writer.

# observe: record the would-be decision and continue.
# enforce: the host must honor allow / block / review.
mode: observe

privacy:
  capture: hashes        # receipts hold hashes and IDs; set "claims" to include claim text
  retention_days: 7

registry:                # every ID referenced below must be declared here
  sources: [product-docs, changelog]
  tools: [docs.search, docs.read, publish.post]

checks:
  evidence:
    min_claims: 1                # an answer that declares no claims is not "verified"
    require_evidence_for_each_claim: true
    require_quote: true          # each claim carries an exact excerpt from its source
    min_quote_chars: 12
    allowed_source_ids: [product-docs, changelog]
    max_source_age_days: 365     # uses trusted published_at, not capture time
  numeric:
    relative_tolerance: 0.005    # 0.5% for rounding
  semantics:                     # independent model assessment: does the claim follow from its quote?
    enabled: false               # needs a Judge at runtime, e.g. @agentproof/judge-anthropic
    timeout_ms: 15000            # a timeout is "unknown" → review, never a pass

final_answer:                # what the writer may show a person
  output_schema:
    type: object
    required: [text, claims]
    properties:
      text: {type: string, minLength: 1}
      claims: {type: array, minItems: 1}

contracts:
  research_to_writer:
    version: 1
    coordinator: writer
    worker: researcher
    deadline_ms: 30000
    allowed_tools: [docs.search, docs.read]
    # This schema doubles as the output format you give the researcher's model.
    output_schema:
      type: object
      additionalProperties: false
      required: [claims]
      properties:
        claims:
          type: array
          minItems: 1
          items:
            type: object
            additionalProperties: false
            required: [text, evidence_ids, quote]
            properties:
              id: {type: string}
              text: {type: string, minLength: 1}
              quote: {type: string, minLength: 1}
              evidence_ids:
                type: array
                minItems: 1
                items: {type: string, minLength: 1}
              value:
                type: object
                additionalProperties: false
                required: [key, value]
                properties:
                  key: {type: string}
                  value: {type: number}
                  unit: {type: string}

enforcement:
  on_required_check_fail: block
  on_required_check_unknown: review
  on_verifier_error: block
  advisory_checks: [evidence.freshness]   # shown in reports, never blocks
  review_timeout_ms: 600000
  max_repair_attempts: 1
`;

export const TEMPLATES: Record<string, string> = {
  "research-handoff": RESEARCH_HANDOFF_TEMPLATE,
};

export function templatePolicy(name: string): CompiledPolicy {
  const text = TEMPLATES[name];
  if (!text) throw new Error(`Unknown template '${name}'. Available: ${Object.keys(TEMPLATES).join(", ")}`);
  return parsePolicy(text);
}
