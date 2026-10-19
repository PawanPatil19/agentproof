/**
 * tools.permission — every tool call observed at a guarded boundary was
 * allowed by the contract and made by the contracted worker.
 *
 * A blocked call still fails this check: a worker that *tried* a forbidden
 * tool should not have its deliverable consumed silently.
 */
import type { ToolEvent } from "../types.ts";
import { pass, plural, result, type Check, type RawResult } from "./context.ts";

export const checkTools: Check = (ctx) => {
  if (ctx.boundary !== "worker_completion" || !ctx.envelope.contract) return [];
  const definition = ctx.policy.contracts.get(ctx.envelope.contract.name)?.definition;
  if (!definition?.allowed_tools) return [];
  const allowed = new Set(definition.allowed_tools);
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
    if (!allowed.has(tool)) {
      const blocked = events.filter((e) => e.outcome === "blocked").length;
      const how = blocked === events.length ? "blocked before invocation" : `invoked ${plural(events.length - blocked, "time")} (observe mode)`;
      return result("tools.permission", target, "fail", "TOOL_NOT_ALLOWED", `'${tool}' is not in allowed_tools; ${how}.`);
    }
    return pass("tools.permission", target, `'${tool}' allowed; called ${plural(events.length, "time")}.`);
  });
};
