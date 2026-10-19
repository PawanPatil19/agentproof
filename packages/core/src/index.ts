/**
 * @agentproof/core — the deterministic verification engine.
 *
 *   const policy = parsePolicy(yamlText);          // or baselinePolicy()
 *   const receipt = verifyRun(runEnvelope, { policy });
 *   receipt.decision;                              // "allow" | "block" | "review"
 */
export * from "./types.ts";
export { API_VERSION, CHECKER_VERSION, RECEIPT_VERSION } from "./version.ts";
export { verifyRun, type VerifyOptions } from "./verify.ts";
export { parseEnvelope, type EnvelopeParse } from "./envelope.ts";
export { decide, markRequired } from "./decide.ts";
export { buildReceipt, amendReceipt, seal, verifyReceiptDigest, hashOutput } from "./receipt.ts";
export {
  compilePolicy,
  parsePolicy,
  contractDefinitionDigest,
  PolicyError,
  type CompiledPolicy,
  type CompiledContract,
  type ContractDefinition,
  type PolicyDocument,
  type PolicyIssue,
} from "./policy/compile.ts";
export { BASELINE_POLICY, RESEARCH_HANDOFF_TEMPLATE, TEMPLATES, baselinePolicy, templatePolicy } from "./policy/presets.ts";
export { contractInstanceDigest, type ContractTerms } from "./contract.ts";
export { CHECK_IDS, INTEGRITY_CHECKS, isCheckId, type CheckId, type RawResult } from "./checks/index.ts";
export { canonicalJson, digestOf, sha256 } from "./util/hash.ts";
export { classifyLocator, normalizeForMatch, redact, safeText, sanitizeLocator, wellFormed, wellFormedDeep } from "./util/text.ts";
export { excerptFor, judgeClaims, type Judge, type JudgeInput, type JudgeResult, type JudgeVerdict } from "./semantics.ts";
export {
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  RECEIPT_PREDICATE_TYPE,
  fromDsseEnvelope,
  generateSigningKey,
  isDsseEnvelope,
  keyIdOf,
  preAuthEncoding,
  receiptPayload,
  receiptStatement,
  signReceipt,
  toDsseEnvelope,
  verifyReceiptSignature,
  type DsseEnvelope,
  type EnvelopeParse as DsseEnvelopeParse,
  type InTotoStatement,
  type SignatureCheck,
  type SignatureFailure,
  type SigningKeyPair,
} from "./signing.ts";
export {
  COMMITMENT_PREFIX,
  claimSalt,
  commitClaimText,
  commitmentKeyBytes,
  generateCommitmentNonce,
  discloseClaim,
  generateCommitmentKey,
  verifyClaimDisclosure,
  type ClaimDisclosure,
  type CommitmentKey,
} from "./commitment.ts";
export { renderReport, type ClaimText, type ReportOptions } from "./report/html.ts";
export { REASON_TEXT } from "./report/reasons.ts";
export { parseReceipt, type ReceiptParse } from "./report/schema.ts";
export {
  fromAnthropicMessage,
  fromCitedSegments,
  fromOpenAIResponse,
  type AdaptedRun,
  type AdaptOptions,
  type AnthropicMessageLike,
  type CitedSegment,
  type NormalizedCitation,
  type OpenAIAdaptOptions,
  type OpenAIResponseLike,
  type SuppliedSource,
} from "./adapters/cited.ts";
