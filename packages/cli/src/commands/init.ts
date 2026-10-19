import { access, writeFile } from "node:fs/promises";
import { TEMPLATES } from "@agentproof/core";
import { flag, parseArgs } from "../args.ts";
import { CliError, EXIT } from "../io.ts";

export const INIT_HELP = `agentproof init [--template research-handoff] [--out agentproof.yaml] [--force]

Write a starter policy in observe mode. Review it before enforcing.`;

export async function init(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: ["template", "out"], booleans: ["force"] });
  const name = flag(args, "template") ?? "research-handoff";
  const template = TEMPLATES[name];
  if (!template) throw new CliError(`unknown template '${name}' (available: ${Object.keys(TEMPLATES).join(", ")})`);
  const out = flag(args, "out") ?? "agentproof.yaml";
  const exists = await access(out).then(() => true, () => false);
  if (exists && !args.flags.force) throw new CliError(`${out} already exists (use --force to overwrite)`);
  await writeFile(out, template);
  console.log(`wrote ${out} from template '${name}' (mode: observe)\nnext: agentproof policy validate ${out}`);
  return EXIT.ALLOW;
}
