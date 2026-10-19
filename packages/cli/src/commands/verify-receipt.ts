import { readFile } from "node:fs/promises";
import { parseReceipt, verifyReceiptSignature } from "@agentproof/core";
import { flag, parseArgs, UsageError } from "../args.ts";
import { CliError, EXIT, readJson } from "../io.ts";
import { c } from "../terminal.ts";

export const VERIFY_RECEIPT_HELP = `agentproof verify-receipt <receipt.json> --public-key issuer.pub

Check that a receipt was issued by the holder of a key and not edited since.
Exit codes: 0 valid · 2 invalid or unsigned · 3 error.`;

const WHY: Record<string, string> = {
  UNSIGNED: "the receipt carries no signature",
  DIGEST_MISMATCH: "the receipt was edited after it was sealed",
  WRONG_KEY: "it was signed by a different key",
  BAD_SIGNATURE: "the signature does not verify",
  UNSUPPORTED_ALG: "the signature algorithm is not supported",
};

export async function verifyReceipt(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: ["public-key"] });
  const [path] = args.positionals;
  const keyPath = flag(args, "public-key");
  if (!path || !keyPath) throw new UsageError("verify-receipt needs a receipt file and --public-key");
  const parsed = parseReceipt(await readJson(path));
  if (!parsed.ok) throw new CliError(`${path} is not a valid AgentProof receipt: ${parsed.problems}`);
  let key: string;
  try {
    key = await readFile(keyPath, "utf8");
  } catch {
    throw new CliError(`cannot read public key ${keyPath}`);
  }
  let check;
  try {
    check = verifyReceiptSignature(parsed.receipt, key);
  } catch (error) {
    throw new CliError(`${keyPath} is not a usable Ed25519 public key: ${(error as Error).message}`);
  }
  const r = parsed.receipt;
  if (!check.ok) {
    console.log(`${c.red("✗")} not verified: ${WHY[check.reason]}`);
    return EXIT.BLOCK;
  }
  console.log(`${c.green("✓")} receipt ${r.run_id} verified · key ${check.keyId} · decision ${r.decision} under ${r.policy.id}@${r.policy.version}`);
  return EXIT.ALLOW;
}
