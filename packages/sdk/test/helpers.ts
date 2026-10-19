import { readFileSync } from "node:fs";
import { parsePolicy } from "@agentproof/core";
import { createVerifier, type VerifierOptions } from "@agentproof/sdk";

export const POLICY = parsePolicy(readFileSync(new URL("../../../fixtures/agentproof.yaml", import.meta.url), "utf8"));
export const WORKER = "agent://researcher-1";
export const COORDINATOR = "agent://writer-1";

/** A controllable clock. */
export function clock(start = "2026-10-19T10:00:00.000Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

export function verifier(options: Partial<VerifierOptions> = {}) {
  let n = 0;
  return createVerifier({ policy: POLICY, store: false, newId: () => String(++n).padStart(4, "0"), ...options });
}

export const DOC = "Version 3.2 shipped on 12 August 2026. Offline sync is now generally available.";

export const deliverable = {
  output: { claims: [{ id: "c1", text: "Offline sync is GA.", quote: "Offline sync is now generally available.", evidence_ids: ["d1"] }] },
  evidence: [{ id: "d1", source_id: "changelog", locator: "https://lumen.example/changelog/3.2", content: DOC, published_at: "2026-08-12" }],
};
