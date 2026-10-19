/**
 * tools.permission — every tool call observed at a guarded boundary was
 * allowed by the contract and made by the contracted worker.
 *
 * A blocked call still fails this check: a worker that *tried* a forbidden
 * tool should not have its deliverable consumed silently.
 */
import type { CompiledContract } from "../policy/compile.ts";
import { exceeds, usageOf } from "../tool-constraints.ts";
import type { ToolEvent } from "../types.ts";
import { pass, plural, result, type Check, type RawResult } from "./context.ts";

export const checkTools: Check = (ctx) => {
  if (ctx.boundary !== "worker_completion" || !ctx.envelope.contract) return [];
  const compiled = ctx.policy.contracts.get(ctx.envelope.contract.name);
  if (!compiled) return []; // contract.binding reports the unknown contract
  const allowed = compiled.allowedTools;
  const worker = ctx.envelope.contract.worker;

  const byTool = new Map<string, ToolEvent[]>();
  for (const event of ctx.envelope.tool_events ?? []) {
    byTool.set(event.tool, [...(byTool.get(event.tool) ?? []), event]);
  }
  if (byTool.size === 0) {
    return [result("tools.permission", "tools", "not_applicable", "NOT_APPLICABLE", "No tool calls were observed at guarded boundaries.")];
  }

  return [...byTool.entries()].map(([tool, events]): RawResult => {
    const target = `tool:${tool}`;
    const strangers = [...new Set(events.filter((e) => e.agent !== worker).map((e) => e.agent))];
    if (strangers.length > 0) {
      return result("tools.permission", target, "fail", "CONTRACT_IDENTITY_MISMATCH", `Called by ${strangers.join(", ")}, not the contracted worker.`);
    }
    if (allowed !== "any" && !allowed.has(tool)) {
      const blocked = events.filter((e) => e.outcome === "blocked").length;
      const how = blocked === events.length ? "blocked before invocation" : `invoked ${plural(events.length - blocked, "time")} (observe mode)`;
      const why = allowed.size === 0 ? "the contract allows no tools" : "it is not in allowed_tools";
      return result("tools.permission", target, "fail", "TOOL_NOT_ALLOWED", `'${tool}' was refused because ${why}; ${how}.`);
    }
    const overLimit = replayLimits(compiled, tool, events);
    if (overLimit) return result("tools.permission", target, "fail", overLimit.reason, overLimit.message);
    const violated = events.find((e) => e.reason_code !== undefined);
    if (violated) {
      return result("tools.permission", target, "fail", violated.reason_code!, `'${tool}' was called outside the contract's terms: ${violated.reason ?? violated.reason_code}.`);
    }
    return pass("tools.permission", target, `'${tool}' allowed; called ${plural(events.length, "time")}.`);
  });
};

/**
 * Re-check recorded usage against the contract's limits, so an envelope from
 * a host that skipped (or misreported) the guard can't pass on missing
 * reason codes. Only the events in this envelope are visible, so this is a
 * lower bound on what the guard counted across retries and tasks.
 */
function replayLimits(compiled: CompiledContract, tool: string, events: ToolEvent[]): { reason: "TOOL_ARGS_INVALID" | "TOOL_LIMIT_EXCEEDED"; message: string } | undefined {
  const rules = compiled.toolConstraints.get(tool)?.definition;
  if (!rules) return undefined;
  const ran = events.filter((e) => e.outcome !== "blocked");
  for (const [i, event] of ran.entries()) {
    if (rules.amount_field && (typeof event.amount !== "number" || !Number.isFinite(event.amount) || event.amount < 0)) {
      return { reason: "TOOL_ARGS_INVALID", message: `'${tool}' ran without a recorded amount, but the contract meters '${rules.amount_field}'.` };
    }
    const amount = event.amount ?? 0;
    if (rules.max_per_call !== undefined && exceeds(amount, rules.max_per_call)) {
      return { reason: "TOOL_LIMIT_EXCEEDED", message: `'${tool}' ran with amount ${amount}, over max_per_call ${rules.max_per_call}.` };
    }
    const at = event.at !== undefined && !Number.isNaN(Date.parse(event.at)) ? new Date(event.at) : new Date(8.64e15);
    const prior = usageOf(ran.slice(0, i), tool, at, rules.window_ms);
    if (rules.max_calls !== undefined && prior.calls + 1 > rules.max_calls) {
      return { reason: "TOOL_LIMIT_EXCEEDED", message: `'${tool}' ran ${prior.calls + 1} times, over max_calls ${rules.max_calls}.` };
    }
    if (rules.max_total !== undefined && exceeds(prior.total + amount, rules.max_total)) {
      return { reason: "TOOL_LIMIT_EXCEEDED", message: `'${tool}' ran to a total of ${prior.total + amount}, over max_total ${rules.max_total}.` };
    }
  }
  return undefined;
}
