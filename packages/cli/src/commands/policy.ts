import { parseArgs, UsageError } from "../args.ts";
import { EXIT, loadPolicy } from "../io.ts";
import { c } from "../terminal.ts";

export const POLICY_HELP = `agentproof policy validate <agentproof.yaml>

Compile a policy: types, unknown keys, registry references, output schemas.`;

export async function policy(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: [] });
  const [sub, path] = args.positionals;
  if (sub !== "validate") throw new UsageError("usage: agentproof policy validate <file>");
  if (!path) throw new UsageError("policy validate needs a file");
  const compiled = await loadPolicy(path);
  console.log(`${c.green("✓")} ${compiled.id}@${compiled.version} is valid · mode ${compiled.mode} · ${compiled.digest}`);
  for (const [name, contract] of compiled.contracts) {
    const d = contract.definition;
    console.log(`  contract ${name}@${d.version}: ${d.worker} → ${d.coordinator}, deadline ${d.deadline_ms} ms, tools [${(d.allowed_tools ?? ["any"]).join(", ")}]`);
  }
  if (compiled.enforcement.advisory.size) console.log(`  advisory: ${[...compiled.enforcement.advisory].join(", ")}`);
  return EXIT.ALLOW;
}
