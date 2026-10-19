/**
 * `npm run demo` — five scenarios through the same gated workflow.
 * Writes receipts and HTML reports to examples/research-handoff/out/.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport, type Mode } from "@agentproof/core";
import { FileReceiptStore, writePrivateFile } from "@agentproof/sdk";
import type { Personality } from "./agents.ts";
import { runHandoff } from "./workflow.ts";

const OUT = fileURLToPath(new URL("../out", import.meta.url));

const SCENARIOS: Array<{ title: string; personality: Personality; mode?: Mode }> = [
  { title: "Honest researcher", personality: "honest" },
  { title: "Cites evidence it never captured → one repair", personality: "sloppy" },
  { title: "Quotes a real source that never says it → one repair", personality: "fabricating" },
  { title: "Tries to publish during a drafting task", personality: "overreaching" },
  { title: "Same as 4, observe mode (records, does not stop)", personality: "overreaching", mode: "observe" },
];

const store = new FileReceiptStore(OUT);
const reports: string[] = [];

for (const [i, scenario] of SCENARIOS.entries()) {
  console.log(`\n${i + 1}. ${scenario.title}${scenario.mode ? ` [${scenario.mode}]` : ""}`);
  const result = await runHandoff({ ...scenario, store, log: (line) => console.log(`   ${line}`) });
  console.log(`   ⇒ outcome: ${result.outcome.toUpperCase()} · publish side effects: ${result.published.length}`);
  for (const receipt of result.receipts) {
    const path = join(OUT, `${receipt.run_id}.html`);
    await writePrivateFile(path, renderReport(receipt, { claimText: result.claimText.get(receipt.run_id) }));
    reports.push(path);
  }
}

console.log(`\nReceipts and ${reports.length} HTML reports written to ${OUT}`);
