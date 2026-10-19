/**
 * An MCP server that fronts one upstream MCP server and puts every tool call
 * through an AgentProof contract before the agent sees the result.
 *
 *   agent ──MCP──▶ gateway ──MCP──▶ upstream server
 *                     │
 *                     └─ contract → guardTools → verifyCompletion → receipt
 *
 * Each call gets its own contract attempt (task `<prefix>/<n>`) under the
 * named policy contract, so every call produces one receipt and calls never
 * share state. The receipt decides what the agent gets back:
 *
 *   allow   the upstream result, with a receipt summary in `_meta`
 *   block   an error result; a refused call never reaches the upstream server
 *   review  an error result saying the call needs a person's approval; nothing
 *           ran, or the result is withheld. There is no in-band approval yet:
 *           the agent retries once a person has cleared it.
 *
 * Only tools are proxied. Resources, prompts and sampling are not exposed,
 * because they would reach the upstream server without passing the gate.
 */
import { randomUUID } from "node:crypto";
import { hashOutput, type Decision, type Receipt, type ReasonCode } from "@agentproof/core";
import { ToolBlockedError, type Verifier } from "@agentproof/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { GATEWAY_VERSION } from "./version.ts";

/** The gateway's configuration can't work: unknown contract, clashing identities, or a policy that blocks every call. */
export class GatewayConfigError extends Error {
  override name = "GatewayConfigError";
}

/** Key under which the receipt summary travels in a tool result's `_meta`. */
export const RECEIPT_META_KEY = "agentproof/receipt";

export interface GatewayOptions {
  verifier: Verifier;
  /** Contract in the verifier's policy that every call runs under. */
  contract: string;
  /** Trusted identity of the agent behind this gateway. Set by the operator, never by the agent. */
  worker: string;
  /** Identity that issues the contract (the operator or orchestrator). Must differ from `worker`. */
  coordinator: string;
  /** A connected client for the upstream MCP server. */
  upstream: Client;
  /** Prefix for per-call task IDs. Defaults to a random `mcp_…` ID per gateway. */
  taskPrefix?: string;
  /**
   * In enforce mode, tools the contract doesn't allow are hidden from
   * `tools/list` so agents don't plan around them. Set true to list them anyway.
   */
  listAllTools?: boolean;
  /** Name the gateway reports to the agent. */
  name?: string;
}

/** What the gateway concluded about one call. */
export interface GatewayCall {
  tool: string;
  /** What the gateway did: the receipt's `decision` (always `allow` in observe mode). */
  decision: Decision;
  receipt: Receipt;
  /** Whether the upstream tool actually ran. */
  executed: boolean;
  result: CallToolResult;
}

export interface ReceiptSummary {
  decision: Decision;
  evaluated_decision: Decision;
  mode: Receipt["mode"];
  run_id: string;
  task_id?: string;
  receipt_sha256: string;
  reason_codes: ReasonCode[];
}

export function summarize(receipt: Receipt): ReceiptSummary {
  return {
    decision: receipt.decision,
    evaluated_decision: receipt.evaluated_decision,
    mode: receipt.mode,
    run_id: receipt.run_id,
    ...(receipt.task_id ? { task_id: receipt.task_id } : {}),
    receipt_sha256: receipt.receipt_sha256,
    reason_codes: receipt.reason_codes,
  };
}

export class Gateway {
  readonly server: Server;
  private readonly options: GatewayOptions;
  private readonly taskPrefix: string;
  private seq = 0;

  constructor(options: GatewayOptions) {
    assertGatewayConfig(options);
    this.options = options;
    this.taskPrefix = options.taskPrefix ?? `mcp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.server = new Server(
      { name: options.name ?? "agentproof-mcp-gateway", version: GATEWAY_VERSION },
      { capabilities: { tools: { listChanged: true } } },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, (request) => this.listTools(request.params?.cursor));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const call = await this.callTool(request.params.name, request.params.arguments ?? {}, extra.signal);
      return call.result;
    });
    // Tell the agent when the upstream tool set changes.
    options.upstream.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.server.sendToolListChanged().catch(() => undefined);
    });
  }

  /** Upstream tools, minus the ones the contract refuses (enforce mode only). */
  async listTools(cursor?: string): Promise<ListToolsResult> {
    const page = await this.options.upstream.listTools(cursor ? { cursor } : undefined);
    const { verifier, contract, listAllTools } = this.options;
    const allowed = verifier.policy.contracts.get(contract)?.allowedTools;
    const hide = verifier.mode === "enforce" && !listAllTools && allowed !== "any";
    return {
      tools: hide ? page.tools.filter((t) => allowed?.has(t.name)) : page.tools,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /** Run one call through the gate. Never throws for policy outcomes; they come back as results. */
  async callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayCall> {
    const { verifier, upstream, worker, coordinator } = this.options;
    const taskId = `${this.taskPrefix}/${++this.seq}`;
    const contract = verifier.issueContract(this.options.contract, { taskId, worker, coordinator });
    verifier.acceptContract(contract, { identity: worker });

    let executed = false;
    const guarded = verifier.guardTools(
      async (name, input) => {
        executed = true;
        // Stop waiting at the contract deadline (a later result is withheld anyway),
        // and pass the agent's cancellation through to the upstream server.
        const timeout = verifier.policy.contracts.get(this.options.contract)?.definition.deadline_ms;
        return (await upstream.callTool({ name, arguments: input as Record<string, unknown> }, undefined, {
          ...(timeout ? { timeout } : {}),
          ...(signal ? { signal } : {}),
        })) as CallToolResult;
      },
      contract,
      { identity: worker },
    );

    let upstreamResult: CallToolResult | undefined;
    let refusal: ToolBlockedError | undefined;
    let failure: Error | undefined;
    try {
      upstreamResult = await guarded(tool, args);
    } catch (error) {
      if (error instanceof ToolBlockedError) refusal = error;
      else failure = error instanceof Error ? error : new Error(String(error));
    }

    // The receipt binds the tool, its arguments and what came back (or why nothing did).
    const output = {
      tool,
      arguments_sha256: hashOutput(args),
      ...(upstreamResult ? { result_sha256: hashOutput(upstreamResult) } : {}),
      ...(refusal ? { refused: refusal.reason } : {}),
      ...(failure ? { upstream_error: failure.message } : {}),
    };
    const receipt = await verifier.verifyCompletion({ contract, output, identity: worker });
    const meta = { [RECEIPT_META_KEY]: summarize(receipt) };

    let result: CallToolResult;
    if (receipt.decision === "allow" && upstreamResult) {
      result = { ...upstreamResult, _meta: { ...upstreamResult._meta, ...meta } };
    } else if (receipt.decision === "allow") {
      result = errorResult(`Upstream tool '${tool}' failed: ${failure?.message ?? "no result"}`, meta);
    } else {
      result = errorResult(refusalText(tool, receipt, executed, refusal), meta);
    }
    return { tool, decision: receipt.decision, receipt, executed, result };
  }

  /** Serve the gateway on a transport (stdio, HTTP, in-memory). */
  async connect(transport: Parameters<Server["connect"]>[0]): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}

export function createGateway(options: GatewayOptions): Gateway {
  return new Gateway(options);
}

/**
 * A tool call's receipt output is the call itself (tool and hashes), not a
 * deliverable with claims. A policy that demands claims or a deliverable
 * shape would block every call, so refuse it up front with the fix.
 */
export function assertGatewayConfig(options: Pick<GatewayOptions, "verifier" | "contract" | "worker" | "coordinator">): void {
  const { policy } = options.verifier;
  const contract = options.contract;
  if (!policy.contracts.has(contract)) throw new GatewayConfigError(`Policy ${policy.id} declares no contract '${contract}'.`);
  if (options.worker === options.coordinator) throw new GatewayConfigError("Worker and coordinator must be different identities.");
  if (policy.evidence.minClaims > 0) {
    throw new GatewayConfigError(`Policy ${policy.id} requires at least ${policy.evidence.minClaims} claim(s) per output, which would block every tool call. Set checks.evidence.min_claims: 0 in the gateway's policy.`);
  }
  if (policy.contracts.get(contract)?.validateOutput) {
    throw new GatewayConfigError(`Contract '${contract}' declares an output_schema; gateway contracts gate tool calls, not deliverables, so remove it.`);
  }
}

function errorResult(text: string, meta: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: "text", text }], _meta: meta };
}

function refusalText(tool: string, receipt: Receipt, executed: boolean, refusal?: ToolBlockedError): string {
  const failed = receipt.checks.filter((c) => c.required && (c.status === "fail" || c.status === "unknown"));
  const why = refusal?.message ?? failed.map((c) => c.message).join(" ") ?? "";
  const codes = receipt.reason_codes.join(", ") || "no reason recorded";
  const what = executed ? "The tool ran, but its result is withheld." : "The tool was not called.";
  const lead =
    receipt.decision === "review"
      ? `AgentProof refused '${tool}' pending human review (${codes}); a person must approve before it is retried.`
      : `AgentProof blocked '${tool}' (${codes}).`;
  return `${lead} ${what} ${why}`.trim() + ` Receipt ${receipt.receipt_sha256}.`;
}
