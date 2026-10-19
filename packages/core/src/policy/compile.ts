import { parse as parseYaml } from "yaml";
import type { ValidateFunction } from "ajv";
import type { Decision, Mode } from "../types.ts";
import { createAjv, describeErrors } from "../util/ajv.ts";
import { digestOf } from "../util/hash.ts";
import { INTEGRITY_CHECKS, isCheckId, type CheckId } from "../checks/ids.ts";
import { POLICY_SCHEMA } from "./schema.ts";

// ── Policy document (what users write) ───────────────────────────────────────

export interface ContractDefinition {
  version: number;
  description?: string;
  /** Logical name of the agent that issues the contract and consumes the deliverable. */
  coordinator: string;
  /** Logical name of the agent that must accept and deliver. */
  worker: string;
  deadline_ms: number;
  allowed_tools?: string[];
  output_schema?: Record<string, unknown>;
}

export interface PolicyDocument {
  api_version: "agentproof/v1";
  policy: { id: string; version: number; description?: string };
  mode?: Mode;
  privacy?: { capture?: "hashes" | "claims"; retention_days?: number };
  registry?: { sources?: string[]; tools?: string[] };
  checks?: {
    evidence?: {
      min_claims?: number;
      require_evidence_for_each_claim?: boolean;
      require_quote?: boolean;
      min_quote_chars?: number;
      verify_content_hash?: boolean;
      allowed_source_ids?: string[];
      max_source_age_days?: number;
    };
    numeric?: { absolute_tolerance?: number; relative_tolerance?: number };
  };
  final_answer?: { output_schema?: Record<string, unknown> };
  contracts?: Record<string, ContractDefinition>;
  enforcement?: {
    on_required_check_fail?: Decision;
    on_required_check_unknown?: Decision;
    on_verifier_error?: Decision;
    advisory_checks?: string[];
    review_timeout_ms?: number;
    max_repair_attempts?: number;
  };
}

// ── Compiled policy (what the engine runs) ───────────────────────────────────

export interface CompiledContract {
  name: string;
  definition: ContractDefinition;
  /** Pins the exact obligations; any edit to the definition changes it. */
  definitionDigest: string;
  validateOutput?: ValidateFunction;
}

export interface CompiledPolicy {
  id: string;
  version: number;
  /** Digest of the whole policy document. Recorded in every receipt. */
  digest: string;
  mode: Mode;
  privacy: { capture: "hashes" | "claims"; retentionDays: number };
  evidence: {
    /** An output with fewer declared claims fails `output.claims`. */
    minClaims: number;
    requireEvidenceForEachClaim: boolean;
    requireQuote: boolean;
    minQuoteChars: number;
    verifyContentHash: boolean;
    allowedSourceIds?: ReadonlySet<string>;
    maxSourceAgeDays?: number;
  };
  numeric: { absoluteTolerance: number; relativeTolerance: number };
  finalAnswerSchema?: ValidateFunction;
  contracts: ReadonlyMap<string, CompiledContract>;
  enforcement: {
    onFail: Decision;
    onUnknown: Decision;
    onVerifierError: Decision;
    advisory: ReadonlySet<CheckId>;
    reviewTimeoutMs: number;
    maxRepairAttempts: number;
  };
  document: PolicyDocument;
}

export interface PolicyIssue {
  path: string;
  message: string;
}

export class PolicyError extends Error {
  readonly issues: PolicyIssue[];
  constructor(issues: PolicyIssue[]) {
    super(`Invalid policy:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`);
    this.name = "PolicyError";
    this.issues = issues;
  }
}

const ajv = createAjv();
const validateDocument = ajv.compile(POLICY_SCHEMA);

/** The digest a contract definition is pinned to. */
export function contractDefinitionDigest(name: string, definition: ContractDefinition): string {
  return digestOf({ name, ...definition });
}

/** Parse YAML text and compile it. YAML aliases are capped to block expansion bombs. */
export function parsePolicy(yamlText: string): CompiledPolicy {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText, { uniqueKeys: true, maxAliasCount: 50, prettyErrors: true });
  } catch (error) {
    throw new PolicyError([{ path: "(yaml)", message: (error as Error).message.split("\n")[0] ?? "parse error" }]);
  }
  return compilePolicy(doc);
}

/**
 * Validate a policy document and resolve defaults. Fails closed: structural
 * errors, unknown keys, unresolved registry references and uncompilable
 * output schemas are all reported together.
 */
export function compilePolicy(doc: unknown): CompiledPolicy {
  if (!validateDocument(doc)) {
    throw new PolicyError(
      (validateDocument.errors ?? []).map((e) => ({
        path: e.instancePath === "" ? "(root)" : e.instancePath,
        message: describeErrors([e]).replace(/^\S+\s/, ""),
      })),
    );
  }
  const policy = doc as unknown as PolicyDocument;
  const issues: PolicyIssue[] = [];

  const registrySources = policy.registry?.sources ? new Set(policy.registry.sources) : undefined;
  const registryTools = policy.registry?.tools ? new Set(policy.registry.tools) : undefined;

  const allowed = policy.checks?.evidence?.allowed_source_ids;
  if (allowed && registrySources) {
    for (const id of allowed) {
      if (!registrySources.has(id)) {
        issues.push({ path: "/checks/evidence/allowed_source_ids", message: `source '${id}' is not in registry.sources` });
      }
    }
  }

  const contracts = new Map<string, CompiledContract>();
  for (const [name, definition] of Object.entries(policy.contracts ?? {})) {
    const path = `/contracts/${name}`;
    if (definition.coordinator === definition.worker) {
      issues.push({ path, message: "coordinator and worker must be different agents" });
    }
    if (definition.allowed_tools && registryTools) {
      for (const tool of definition.allowed_tools) {
        if (!registryTools.has(tool)) issues.push({ path: `${path}/allowed_tools`, message: `tool '${tool}' is not in registry.tools` });
      }
    }
    const compiled: CompiledContract = { name, definition, definitionDigest: contractDefinitionDigest(name, definition) };
    if (definition.output_schema) {
      try {
        compiled.validateOutput = ajv.compile(definition.output_schema);
      } catch (error) {
        issues.push({ path: `${path}/output_schema`, message: (error as Error).message });
      }
    }
    contracts.set(name, compiled);
  }

  let finalAnswerSchema: ValidateFunction | undefined;
  if (policy.final_answer?.output_schema) {
    try {
      finalAnswerSchema = ajv.compile(policy.final_answer.output_schema);
    } catch (error) {
      issues.push({ path: "/final_answer/output_schema", message: (error as Error).message });
    }
  }

  const advisory = new Set<CheckId>();
  for (const id of policy.enforcement?.advisory_checks ?? []) {
    if (!isCheckId(id)) issues.push({ path: "/enforcement/advisory_checks", message: `unknown check '${id}'` });
    else if (INTEGRITY_CHECKS.has(id)) issues.push({ path: "/enforcement/advisory_checks", message: `'${id}' guards the verification boundary and cannot be advisory` });
    else advisory.add(id);
  }

  if (issues.length > 0) throw new PolicyError(issues);

  const evidence = policy.checks?.evidence ?? {};
  return {
    id: policy.policy.id,
    version: policy.policy.version,
    digest: digestOf(policy),
    mode: policy.mode ?? "observe",
    privacy: {
      capture: policy.privacy?.capture ?? "hashes",
      retentionDays: policy.privacy?.retention_days ?? 7,
    },
    evidence: {
      minClaims: evidence.min_claims ?? 1,
      requireEvidenceForEachClaim: evidence.require_evidence_for_each_claim ?? true,
      requireQuote: evidence.require_quote ?? false,
      minQuoteChars: evidence.min_quote_chars ?? 12,
      verifyContentHash: evidence.verify_content_hash ?? true,
      allowedSourceIds: evidence.allowed_source_ids ? new Set(evidence.allowed_source_ids) : undefined,
      maxSourceAgeDays: evidence.max_source_age_days,
    },
    numeric: {
      absoluteTolerance: policy.checks?.numeric?.absolute_tolerance ?? 0,
      relativeTolerance: policy.checks?.numeric?.relative_tolerance ?? 0,
    },
    finalAnswerSchema,
    contracts,
    enforcement: {
      onFail: policy.enforcement?.on_required_check_fail ?? "block",
      onUnknown: policy.enforcement?.on_required_check_unknown ?? "review",
      onVerifierError: policy.enforcement?.on_verifier_error ?? "block",
      advisory,
      reviewTimeoutMs: policy.enforcement?.review_timeout_ms ?? 600_000,
      maxRepairAttempts: policy.enforcement?.max_repair_attempts ?? 1,
    },
    document: policy,
  };
}
