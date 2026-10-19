import type { ReasonCode } from "@agentproof/core";

export class AgentProofError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "AgentProofError";
    this.reason = reason;
  }
}

/** Thrown by a guarded executor in enforce mode. The underlying tool was never called. */
export class ToolBlockedError extends AgentProofError {
  readonly tool: string;
  constructor(tool: string, reason: ReasonCode, message: string) {
    super(reason, message);
    this.name = "ToolBlockedError";
    this.tool = tool;
  }
}

/** A contract lifecycle rule was violated (wrong identity, digest, state or repair limit). */
export class ContractError extends AgentProofError {
  constructor(reason: ReasonCode | "REPAIR_LIMIT_REACHED", message: string) {
    super(reason, message);
    this.name = "ContractError";
  }
}

export type ApprovalFailure = "APPROVAL_UNKNOWN" | "APPROVAL_USED" | "APPROVAL_EXPIRED" | "APPROVAL_OUTPUT_CHANGED" | "APPROVAL_RECEIPT_MISMATCH" | "APPROVAL_NOT_REVIEWABLE";

/** A review approval could not be issued or redeemed. */
export class ApprovalError extends AgentProofError {
  constructor(reason: ApprovalFailure, message: string) {
    super(reason, message);
    this.name = "ApprovalError";
  }
}
