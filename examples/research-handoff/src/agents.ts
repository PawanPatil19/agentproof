/**
 * Deterministic stand-ins for LLM agents, so the example runs offline and
 * reproducibly. Each researcher "personality" reproduces one real failure.
 */
import type { Claim, EvidenceRecord } from "@agentproof/core";
import type { ToolExecutor } from "@agentproof/sdk";

export type Personality = "honest" | "sloppy" | "fabricating" | "overreaching";

export interface Deliverable {
  output: { claims: Claim[] };
  evidence: EvidenceRecord[];
}

/** The researcher (worker). Only ever touches tools through the guarded executor it is handed. */
export async function researcher(personality: Personality, tools: ToolExecutor): Promise<Deliverable> {
  const ids = (await tools("docs.search", { query: "offline sync pricing" })) as string[];
  const evidence: EvidenceRecord[] = [];
  for (const id of ids) evidence.push((await tools("docs.read", { id })) as EvidenceRecord);

  const claims: Claim[] = [
    {
      id: "c1",
      text: "Offline sync is generally available as of version 3.2.",
      quote: "Offline sync is now generally available.",
      evidence_ids: ["doc-changelog-3-2"],
    },
    {
      id: "c2",
      text: "Notes can be exported to PDF and Markdown.",
      quote: "Exports are available as PDF and Markdown.",
      evidence_ids: ["doc-capabilities"],
    },
    {
      id: "c3",
      text: "The Pro plan costs $12 per member per month.",
      quote: "Pricing for the Pro plan is $12 per member per month.",
      evidence_ids: ["doc-changelog-3-2"],
      value: { key: "pro_price", value: 12, unit: "USD/member/month" },
    },
  ];

  if (personality === "sloppy") {
    // Cites a source it never captured — a classic broken handoff.
    claims[1] = { ...claims[1]!, evidence_ids: ["src-404"] };
  }
  if (personality === "fabricating") {
    // A real source, a plausible quote, and the source never says it.
    claims[0] = {
      id: "c1",
      text: "Offline sync launched in June 2026.",
      quote: "Offline sync launched in June 2026.",
      evidence_ids: ["doc-changelog-3-2"],
    };
  }
  if (personality === "overreaching") {
    // A drafting task should never publish. Like a real agent loop, a failed
    // tool call comes back as an error the agent shrugs off and carries on.
    try {
      await tools("publish.post", { body: claims.map((c) => c.text).join("\n") });
    } catch {
      /* tool error surfaced to the model */
    }
  }
  return { output: { claims }, evidence };
}

/** The writer (coordinator) turns accepted claims into an answer for a person. */
export function writer(claims: Claim[]): { text: string; claims: Claim[] } {
  const text = ["What's new in Lumen Notes 3.2:", ...claims.map((c) => `• ${c.text}`)].join("\n");
  return { text, claims };
}
