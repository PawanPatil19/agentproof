/**
 * The reference handoff: writer (coordinator) → researcher (worker) → writer → person.
 *
 * Three gates, in the order work flows:
 *   guardTools        each researcher tool call, before it runs
 *   verifyCompletion  the researcher's deliverable, before the writer reads it
 *   verifyAnswer      the writer's answer, before a person sees it
 */
import { fileURLToPath } from "node:url";
import type { Mode, Receipt } from "@agentproof/core";
import { createVerifier, ToolBlockedError, type ReceiptStore, type ToolExecutor } from "@agentproof/sdk";
import { researcher, writer, type Personality } from "./agents.ts";
import { read, search } from "./sources.ts";

export const POLICY_FILE = fileURLToPath(new URL("../agentproof.yaml", import.meta.url));

/** Trusted runtime identities. In production these come from per-agent credentials. */
export const RESEARCHER = "agent://researcher-1";
export const WRITER = "agent://writer-1";

export interface HandoffResult {
  outcome: "released" | "blocked" | "review";
  receipts: Receipt[];
  /** Side effects of the publish tool. Must stay empty under enforcement. */
  published: string[];
  answer?: string;
  /** Claim text per receipt run ID, for local reports. */
  claimText: Map<string, Map<string, { text: string; quote?: string }>>;
}

export async function runHandoff(options: {
  personality: Personality;
  mode?: Mode;
  store?: ReceiptStore | false;
  log?: (line: string) => void;
}): Promise<HandoffResult> {
  const log = options.log ?? (() => {});
  const proof = await createVerifier({
    policyFile: POLICY_FILE,
    mode: options.mode,
    store: options.store ?? false,
    identities: { researcher: [RESEARCHER], writer: [WRITER] },
  });

  const published: string[] = [];
  const realTools: ToolExecutor = async (tool, args) => {
    const a = args as { query?: string; id?: string; body?: string };
    if (tool === "docs.search") return search(a.query ?? "");
    if (tool === "docs.read") return read(a.id ?? "", new Date().toISOString());
    if (tool === "publish.post") {
      published.push(a.body ?? "");
      return { ok: true };
    }
    throw new Error(`unknown tool ${tool}`);
  };

  const receipts: Receipt[] = [];
  const claimText = new Map<string, Map<string, { text: string; quote?: string }>>();
  let personality = options.personality;
  let contract = proof.issueContract("research_to_writer", { taskId: "task-42", worker: RESEARCHER, coordinator: WRITER });

  for (;;) {
    contract = proof.acceptContract(contract, { identity: RESEARCHER });
    log(`writer issued ${contract.name}@${contract.version} attempt ${contract.attempt}; researcher accepted ${contract.digest.slice(0, 19)}…`);

    // The researcher only ever sees the guarded executor, with identity bound by the host.
    const guarded = proof.guardTools(realTools, contract, { identity: RESEARCHER });
    const tools: ToolExecutor = async (tool, args) => {
      try {
        const value = await guarded(tool, args);
        log(`  ✓ ${tool}`);
        return value;
      } catch (error) {
        if (error instanceof ToolBlockedError) log(`  ✗ ${tool} blocked before invocation (${error.reason})`);
        throw error;
      }
    };
    const deliverable = await researcher(personality, tools);

    const receipt = await proof.verifyCompletion({ contract, ...deliverable, identity: RESEARCHER });
    receipts.push(receipt);
    claimText.set(receipt.run_id, new Map(deliverable.output.claims.map((c) => [c.id as string, { text: c.text, quote: c.quote }])));
    log(`researcher → writer handoff: ${describe(receipt)}`);

    if (receipt.decision === "review") return { outcome: "review", receipts, published, claimText };
    if (receipt.decision === "block") {
      const repairable = receipt.reason_codes.every((r) => r.startsWith("EVIDENCE_") || r.startsWith("QUOTE_") || r === "SCHEMA_INVALID");
      if (!repairable || contract.attempt > proof.policy.enforcement.maxRepairAttempts) {
        log("writer stops the task; nothing downstream sees the deliverable.");
        return { outcome: "blocked", receipts, published, claimText };
      }
      log(`writer requests a repair: ${receipt.reason_codes.join(", ")}`);
      contract = proof.retry(contract);
      personality = "honest"; // the worker fixes what the receipt pointed at
      continue;
    }

    // Allowed: the writer consumes the claims, and its answer is gated again before release.
    const answer = writer(deliverable.output.claims);
    const final = await proof.verifyAnswer({ output: answer, evidence: deliverable.evidence, taskId: contract.task_id });
    receipts.push(final);
    claimText.set(final.run_id, new Map(answer.claims.map((c) => [c.id as string, { text: c.text, quote: c.quote }])));
    log(`writer → person final answer: ${describe(final)}`);
    return final.decision === "allow"
      ? { outcome: "released", receipts, published, answer: answer.text, claimText }
      : { outcome: final.decision === "review" ? "review" : "blocked", receipts, published, claimText };
  }
}

function describe(r: Receipt): string {
  const head = r.decision.toUpperCase();
  const would = r.decision !== r.evaluated_decision ? ` (would ${r.evaluated_decision} in enforce mode)` : "";
  const why = r.reason_codes.length ? ` — ${r.reason_codes.join(", ")}` : "";
  return `${head}${would} · ${r.coverage.claims_passing}/${r.coverage.claims_total} claims${why}`;
}
