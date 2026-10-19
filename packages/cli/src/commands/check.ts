import { verifyRun, type Mode } from "@agentproof/core";
import { flag, parseArgs, UsageError } from "../args.ts";
import { claimTextOf, EXIT, loadPolicy, readJson, writeOutputs } from "../io.ts";
import { formatReceipt } from "../terminal.ts";

export const CHECK_HELP = `agentproof check <run.json> --policy agentproof.yaml [--mode enforce|observe] [--out dir] [--json]

Gate a run under a policy. Exit codes: 0 allow · 2 block or review · 3 error.
A replayed check cannot undo actions that already happened.`;

export async function check(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: ["policy", "mode", "out"], booleans: ["json"] });
  const [runPath] = args.positionals;
  if (!runPath) throw new UsageError("check needs a run file");
  const policyPath = flag(args, "policy");
  if (!policyPath) throw new UsageError("check needs --policy (use 'inspect' for policy-free diagnostics)");
  const mode = flag(args, "mode");
  if (mode !== undefined && mode !== "enforce" && mode !== "observe") throw new UsageError("--mode must be enforce or observe");

  const run = await readJson(runPath);
  const policy = await loadPolicy(policyPath);
  const receipt = verifyRun(run, { policy, mode: mode as Mode | undefined });
  const paths = await writeOutputs(receipt, flag(args, "out") ?? "agentproof-reports", claimTextOf(run));
  console.log(args.flags.json ? JSON.stringify(receipt, null, 2) : formatReceipt(receipt, paths));
  return receipt.decision === "allow" ? EXIT.ALLOW : EXIT.BLOCK;
}
