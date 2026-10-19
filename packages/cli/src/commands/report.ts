import { renderReport, verifyReceiptDigest, type Receipt } from "@agentproof/core";
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
  const receipt = (await readJson(receiptPath)) as Receipt;
  if (receipt?.receipt_version !== "agentproof.receipt/v1") throw new CliError(`${receiptPath} is not an AgentProof receipt`);
  if (!verifyReceiptDigest(receipt)) console.error("warning: receipt digest does not match its contents — it was edited after sealing");
  const runPath = flag(args, "run");
  const claimText = runPath ? claimTextOf(await readJson(runPath)) : undefined;
  const out = flag(args, "out") ?? receiptPath.replace(/\.json$/, "") + ".html";
  await writePrivateFile(out, renderReport(receipt, { claimText }));
  console.log(out);
  return EXIT.ALLOW;
}
