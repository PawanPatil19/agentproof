import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSigningKey } from "@agentproof/core";
import { flag, parseArgs, UsageError } from "../args.ts";
import { CliError, EXIT } from "../io.ts";

export const KEYS_HELP = `agentproof keys generate [--out dir] [--force]

Create an Ed25519 key pair for signing receipts. The private key is written
with owner-only permissions; share only the .pub file with counterparties.`;

export async function keys(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: ["out"], booleans: ["force"] });
  if (args.positionals[0] !== "generate") throw new UsageError("usage: agentproof keys generate [--out dir]");
  const dir = flag(args, "out") ?? ".";
  const privatePath = join(dir, "agentproof-signing.key");
  const publicPath = join(dir, "agentproof-signing.pub");
  if (!args.flags.force && (await access(privatePath).then(() => true, () => false))) {
    throw new CliError(`${privatePath} already exists (use --force to overwrite)`);
  }
  await mkdir(dir, { recursive: true });
  const pair = generateSigningKey();
  await writeFile(privatePath, pair.privateKeyPem, { mode: 0o600 });
  await writeFile(publicPath, pair.publicKeyPem);
  console.log(`key id ${pair.keyId}\n  private ${privatePath}  (keep secret; never commit)\n  public  ${publicPath}  (share with counterparties)`);
  return EXIT.ALLOW;
}
