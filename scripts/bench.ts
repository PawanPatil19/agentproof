/**
 * Acceptance A07: warm deterministic verification of 20 declared claims over
 * ~1 MB of supplied evidence. Excludes agent execution, retrieval and any
 * model judging. Reports p50/p95/p99 and heap.
 *
 *   npm run bench
 */
import { cpus } from "node:os";
import { sha256, templatePolicy, verifyRun } from "@agentproof/core";

const RUNS = 1000;
const WARMUP = 50;
const CLAIMS = 20;
const policy = templatePolicy("research-handoff");

// 20 records × ~52 KB ≈ 1 MB of content. Each claim quotes a sentence near the end of its record.
const filler = "Lumen Notes keeps your workspace in sync across every device you use. ".repeat(740);
const evidence = Array.from({ length: CLAIMS }, (_, i) => {
  const content = `${filler}Fact number ${i} is recorded in this document for verification.`;
  return {
    id: `doc-${i}`,
    source_id: i % 2 ? "product-docs" : "changelog",
    locator: `https://docs.lumen.example/page/${i}`,
    content,
    content_sha256: sha256(content),
    published_at: "2026-08-01",
    values: { [`metric_${i}`]: { value: 100 + i, unit: "ms" } },
  };
});
const claims = evidence.map((e, i) => ({
  id: `c${i}`,
  text: `Fact ${i} holds.`,
  quote: `Fact number ${i} is recorded in this document`,
  evidence_ids: [e.id],
  value: { key: `metric_${i}`, value: 100 + i, unit: "ms" },
}));
const run = {
  api_version: "agentproof/v1" as const,
  run_id: "bench",
  boundary: "final_answer" as const,
  output: { claims },
  evidence,
  submitted_at: "2026-10-19T10:00:00.000Z",
};
const bytes = evidence.reduce((n, e) => n + Buffer.byteLength(e.content), 0);

for (let i = 0; i < WARMUP; i++) verifyRun(run, { policy });
const times: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const t = performance.now();
  const receipt = verifyRun(run, { policy });
  times.push(performance.now() - t);
  if (i === 0 && receipt.coverage.claims_passing !== CLAIMS) throw new Error(`bench input should pass: ${receipt.reason_codes}`);
}
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]!.toFixed(2);
const heap = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

console.log(`AgentProof bench · ${CLAIMS} claims · ${(bytes / 1024 / 1024).toFixed(2)} MB evidence · ${RUNS} warm runs`);
console.log(`machine: ${cpus().length} × ${cpus()[0]?.model ?? "cpu"} · node ${process.version}`);
console.log(`p50 ${pct(50)} ms · p95 ${pct(95)} ms · p99 ${pct(99)} ms · heap ${heap} MB`);
console.log(Number(pct(95)) <= 100 ? "✓ within the 100 ms p95 target" : "✗ exceeds the 100 ms p95 target");
