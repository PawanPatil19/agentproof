/** File helpers shared by commands. Errors carry the path so messages are actionable. */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { baselinePolicy, parseEnvelope, parsePolicy, renderReport, type ClaimText, type CompiledPolicy, type Receipt } from "@agentproof/core";
import { FileReceiptStore, writePrivateFile } from "@agentproof/sdk";

export const EXIT = { ALLOW: 0, BLOCK: 2, ERROR: 3 } as const;

export class CliError extends Error {}

export async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`cannot read ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

export async function loadPolicy(path: string | undefined, preset = "baseline"): Promise<CompiledPolicy> {
  if (!path) {
    if (preset !== "baseline") throw new CliError(`unknown preset '${preset}' (available: baseline)`);
    return baselinePolicy();
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`cannot read policy ${path}`);
  }
  return parsePolicy(text); // PolicyError is reported by the entry point
}

/** Claim text and quotes from a run file, for the local report only. */
export function claimTextOf(run: unknown): Map<string, ClaimText> {
  const parsed = parseEnvelope(run);
  const map = new Map<string, ClaimText>();
  if (parsed.ok) for (const c of parsed.claims) map.set(c.id, { text: c.text, quote: c.quote });
  return map;
}

/** Persist the receipt and its HTML report side by side. */
export async function writeOutputs(receipt: Receipt, outDir: string, claimText?: Map<string, ClaimText>) {
  const store = new FileReceiptStore(outDir);
  const receiptPath = await store.save(receipt);
  const html = renderReport(receipt, { claimText });
  const reportPath = join(outDir, basename(receiptPath).replace(/\.json$/, ".html"));
  await writePrivateFile(reportPath, html);
  await writePrivateFile(join(outDir, "latest.html"), html);
  return { receipt: receiptPath, report: reportPath };
}
