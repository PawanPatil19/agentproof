/**
 * Argument constraints for guarded tool calls: the difference between
 * "may call payments.send" and "may send at most 50 SGD per call, 200 in
 * total, only to these merchants".
 *
 * Pure and synchronous so every host (the SDK guard, a gateway, a replay)
 * reaches the same verdict. The caller supplies prior usage; this module
 * never stores anything.
 */
import type { CompiledContract } from "./policy/compile.ts";
import type { ReasonCode, ToolEvent } from "./types.ts";
import { describeErrors } from "./util/ajv.ts";

/** Authority already used for one tool, before the call being evaluated. */
export interface ToolUsage {
  calls: number;
  total: number;
}

export type ToolCallVerdict =
  | { ok: true; amount?: number; consumed?: { calls: number; total?: number } }
  | { ok: false; reason: Extract<ReasonCode, "TOOL_ARGS_INVALID" | "TOOL_LIMIT_EXCEEDED">; message: string; amount?: number };

const MISSING = Symbol("missing");

/** Read a dotted path through own properties only, so `__proto__` and friends never resolve. */
function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) return MISSING;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Tolerate binary floating-point noise (0.1 + 0.2) without letting real overspend through. */
export const exceeds = (value: number, limit: number) => value - limit > 1e-9 * Math.max(1, Math.abs(limit));

/**
 * Sum the authority already used for `tool` from earlier events. Blocked calls
 * never ran, so they use nothing. With `windowMs`, only events newer than
 * `now - windowMs` count; events without a timestamp always count (fail closed).
 */
export function usageOf(events: readonly ToolEvent[], tool: string, now: Date, windowMs?: number): ToolUsage {
  const since = windowMs === undefined ? -Infinity : now.getTime() - windowMs;
  let calls = 0;
  let total = 0;
  for (const event of events) {
    if (event.tool !== tool || event.outcome === "blocked") continue;
    if (event.at !== undefined && Date.parse(event.at) <= since) continue;
    calls += 1;
    total += event.amount ?? 0;
  }
  return { calls, total };
}

/**
 * Decide whether one call's arguments fit the contract's constraints for that
 * tool. Tools without constraints always pass here (the name allowlist is
 * checked separately). Messages name fields and limits, never argument values.
 */
export function evaluateToolCall(contract: CompiledContract, tool: string, args: unknown, prior: ToolUsage): ToolCallVerdict {
  const constraint = contract.toolConstraints.get(tool);
  if (!constraint) return { ok: true };
  const rules = constraint.definition;

  if (constraint.validateArgs && !constraint.validateArgs(args)) {
    return { ok: false, reason: "TOOL_ARGS_INVALID", message: `'${tool}' arguments do not match args_schema: ${describeErrors(constraint.validateArgs.errors)}.` };
  }

  for (const [field, allowed] of Object.entries(rules.allowed_values ?? {})) {
    const value = readPath(args, field);
    if (value === MISSING) return { ok: false, reason: "TOOL_ARGS_INVALID", message: `'${tool}' call has no '${field}', which the contract restricts.` };
    if (!allowed.some((candidate) => candidate === value)) {
      return { ok: false, reason: "TOOL_ARGS_INVALID", message: `'${tool}' call uses a '${field}' value outside allowed_values.` };
    }
  }

  let amount: number | undefined;
  if (rules.amount_field) {
    const value = readPath(args, rules.amount_field);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { ok: false, reason: "TOOL_ARGS_INVALID", message: `'${tool}' call needs '${rules.amount_field}' as a non-negative number; the contract meters it.` };
    }
    amount = value;
  }

  if (rules.max_per_call !== undefined && amount !== undefined && exceeds(amount, rules.max_per_call)) {
    return { ok: false, reason: "TOOL_LIMIT_EXCEEDED", message: `'${tool}' amount ${amount} is over max_per_call ${rules.max_per_call}.`, amount };
  }
  const calls = prior.calls + 1;
  if (rules.max_calls !== undefined && calls > rules.max_calls) {
    return { ok: false, reason: "TOOL_LIMIT_EXCEEDED", message: `'${tool}' already called ${prior.calls} of max_calls ${rules.max_calls}${rules.window_ms ? " in the window" : ""}.`, amount };
  }
  const total = prior.total + (amount ?? 0);
  if (rules.max_total !== undefined && exceeds(total, rules.max_total)) {
    return {
      ok: false,
      reason: "TOOL_LIMIT_EXCEEDED",
      message: `'${tool}' would bring the total to ${total}, over max_total ${rules.max_total}${rules.window_ms ? " in the window" : ""} (${prior.total} used).`,
      amount,
    };
  }
  return { ok: true, amount, consumed: rules.amount_field ? { calls, total } : { calls } };
}
