import { FileReceiptStore } from "@agentproof/sdk";
import { flag, parseArgs, UsageError } from "../args.ts";
import { EXIT } from "../io.ts";

export const PRUNE_HELP = `agentproof prune [--days 7] [--dir agentproof-reports]

Delete local receipts and reports older than the retention window.`;

export async function prune(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: ["days", "dir"] });
  const days = Number(flag(args, "days") ?? 7);
  if (!Number.isFinite(days) || days < 0) throw new UsageError("--days must be a non-negative number");
  const removed = await new FileReceiptStore(flag(args, "dir") ?? "agentproof-reports").prune(days);
  console.log(`removed ${removed.length} file${removed.length === 1 ? "" : "s"} older than ${days} days`);
  return EXIT.ALLOW;
}
