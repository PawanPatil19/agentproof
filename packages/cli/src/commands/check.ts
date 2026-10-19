import { readFile } from "node:fs/promises";
import { signReceipt, toDsseEnvelope, verifyRun, type Mode } from "@agentproof/core";
import { writePrivateFile } from "@agentproof/sdk";
import { flag, parseArgs, UsageError } from "../args.ts";
import { CliError, claimTextOf, EXIT, loadPolicy, readJson, writeOutputs } from "../io.ts";
import { formatReceipt } from "../terminal.ts";
import { commitmentKeyFromFile } from "./commitment-key.ts";

export const CHECK_HELP = `agentproof check <run.json> --policy agentproof.yaml [--mode enforce|observe] [--sign-key file] [--commitment-key file] [--out dir] [--json]

Gate a run under a policy. Exit codes: 0 allow · 2 block or review · 3 error.
A replayed check cannot undo actions that already happened.
--sign-key also writes the receipt as a DSSE envelope (<run>.dsse.json).
--commitment-key keeps claim commitments openable for an auditor later.`;

export async function check(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: ["policy", "mode", "out", "sign-key", "commitment-key"], booleans: ["json"] });
  const [runPath] = args.positionals;
  if (!runPath) throw new UsageError("check needs a run file");
  const policyPath = flag(args, "policy");
  if (!policyPath) throw new UsageError("check needs --policy (use 'inspect' for policy-free diagnostics)");
  const mode = flag(args, "mode");
  if (mode !== undefined && mode !== "enforce" && mode !== "observe") throw new UsageError("--mode must be enforce or observe");

  const run = await readJson(runPath);
  const policy = await loadPolicy(policyPath);
  const commitmentKeyPath = flag(args, "commitment-key");
  const commitmentKey = commitmentKeyPath === undefined ? undefined : await commitmentKeyFromFile(commitmentKeyPath);
  let receipt = verifyRun(run, { policy, mode: mode as Mode | undefined, commitmentKey });
  const keyPath = flag(args, "sign-key");
  if (keyPath) {
    const key = await readFile(keyPath, "utf8").catch(() => {
      throw new CliError(`cannot read signing key ${keyPath}`);
    });
    receipt = signReceipt(receipt, key);
  }
  const paths: { receipt: string; report: string; envelope?: string } = await writeOutputs(receipt, flag(args, "out") ?? "agentproof-reports", claimTextOf(run));
  if (receipt.signature) {
    paths.envelope = paths.receipt.replace(/\.json$/, ".dsse.json");
    await writePrivateFile(paths.envelope, `${JSON.stringify(toDsseEnvelope(receipt), null, 2)}\n`);
  }
  console.log(args.flags.json ? JSON.stringify(receipt, null, 2) : formatReceipt(receipt, paths));
  return receipt.decision === "allow" ? EXIT.ALLOW : EXIT.BLOCK;
}
