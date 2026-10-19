#!/usr/bin/env node
/**
 * agentproof — local diagnostics and CI gate.
 * Exit codes: 0 allow / success · 2 block or review · 3 configuration or runtime error.
 */
import { PolicyError, CHECKER_VERSION } from "@agentproof/core";
import { UsageError } from "./args.ts";
import { check, CHECK_HELP } from "./commands/check.ts";
import { init, INIT_HELP } from "./commands/init.ts";
import { inspect, INSPECT_HELP } from "./commands/inspect.ts";
import { keys, KEYS_HELP } from "./commands/keys.ts";
import { policy, POLICY_HELP } from "./commands/policy.ts";
import { prune, PRUNE_HELP } from "./commands/prune.ts";
import { report, REPORT_HELP } from "./commands/report.ts";
import { verifyReceipt, VERIFY_RECEIPT_HELP } from "./commands/verify-receipt.ts";
import { CliError, EXIT } from "./io.ts";

const COMMANDS: Record<string, { run: (argv: string[]) => Promise<number>; help: string }> = {
  inspect: { run: inspect, help: INSPECT_HELP },
  check: { run: check, help: CHECK_HELP },
  report: { run: report, help: REPORT_HELP },
  init: { run: init, help: INIT_HELP },
  policy: { run: policy, help: POLICY_HELP },
  prune: { run: prune, help: PRUNE_HELP },
  keys: { run: keys, help: KEYS_HELP },
  "verify-receipt": { run: verifyReceipt, help: VERIFY_RECEIPT_HELP },
};

const HELP = `agentproof ${CHECKER_VERSION} — evidence and contract checks for agent output

Usage: agentproof <command> [options]

  inspect  <run.json>              diagnose a run with the baseline preset (observe only)
  check    <run.json> --policy f   gate a run under a policy (exit 0 allow, 2 block/review)
  report   <receipt.json>          render a receipt as HTML
  init                             write a starter agentproof.yaml
  policy   validate <file>         compile and validate a policy
  prune                            delete receipts past the retention window
  keys     generate                create an Ed25519 key pair for signing receipts
  verify-receipt <r> --public-key  check who issued a receipt and that it is unedited

Run 'agentproof <command> --help' for details. Nothing here makes network requests.`;

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    console.log(HELP);
    return EXIT.ALLOW;
  }
  if (name === "--version" || name === "-v") {
    console.log(CHECKER_VERSION);
    return EXIT.ALLOW;
  }
  const command = COMMANDS[name];
  if (!command) {
    console.error(`agentproof: unknown command '${name}'\n\n${HELP}`);
    return EXIT.ERROR;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(command.help);
    return EXIT.ALLOW;
  }
  try {
    return await command.run(rest);
  } catch (error) {
    if (error instanceof UsageError) console.error(`agentproof ${name}: ${error.message}\n\n${command.help}`);
    else if (error instanceof PolicyError || error instanceof CliError) console.error(`agentproof ${name}: ${error.message}`);
    else console.error(`agentproof ${name}: unexpected error: ${(error as Error).stack ?? error}`);
    return EXIT.ERROR;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
