import { verifyRun } from "@agentproof/core";
import { flag, parseArgs, UsageError } from "../args.ts";
import { claimTextOf, EXIT, loadPolicy, readJson, writeOutputs } from "../io.ts";
import { formatReceipt } from "../terminal.ts";

export const INSPECT_HELP = `agentproof inspect <run.json> [--policy file | --preset baseline] [--out dir]

Diagnose a captured run. Always observe mode: shows what would be blocked,
never fails the build. Writes a receipt and a local HTML report. Offline.`;

export async function inspect(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: ["policy", "preset", "out"], booleans: ["offline", "json"] });
  const [runPath] = args.positionals;
  if (!runPath) throw new UsageError("inspect needs a run file");
  const run = await readJson(runPath);
  const policy = await loadPolicy(flag(args, "policy"), flag(args, "preset"));
  const receipt = verifyRun(run, { policy, mode: "observe" });
  const paths = await writeOutputs(receipt, flag(args, "out") ?? "agentproof-reports", claimTextOf(run));
  console.log(args.flags.json ? JSON.stringify(receipt, null, 2) : formatReceipt(receipt, paths));
  return EXIT.ALLOW;
}
