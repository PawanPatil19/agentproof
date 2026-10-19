import { parseReceipt, renderReport, verifyReceiptDigest } from "@agentproof/core";
import { writePrivateFile } from "@agentproof/sdk";
import { flag, parseArgs, UsageError } from "../args.ts";
import { CliError, claimTextOf, EXIT, readJson } from "../io.ts";

export const REPORT_HELP = `agentproof report <receipt.json> [--run run.json] [--out report.html]

Render a receipt as a self-contained HTML report. Pass --run to show claim
text from the original run file (it never comes from the receipt by default).`;

export async function report(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: ["run", "out"] });
  const [receiptPath] = args.positionals;
  if (!receiptPath) throw new UsageError("report needs a receipt file");
  // Receipt files are untrusted input: validate shape before rendering anything.
  const parsed = parseReceipt(await readJson(receiptPath));
  if (!parsed.ok) throw new CliError(`${receiptPath} is not a valid AgentProof receipt: ${parsed.problems}`);
  const { receipt } = parsed;
  if (!verifyReceiptDigest(receipt)) console.error("warning: receipt digest does not match its contents — it was edited after sealing");
  const runPath = flag(args, "run");
  const claimText = runPath ? claimTextOf(await readJson(runPath)) : undefined;
  const out = flag(args, "out") ?? receiptPath.replace(/\.json$/, "") + ".html";
  await writePrivateFile(out, renderReport(receipt, { claimText }));
  console.log(out);
  return EXIT.ALLOW;
}
