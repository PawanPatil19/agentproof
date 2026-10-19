import { readFile } from "node:fs/promises";
import { fromDsseEnvelope, isDsseEnvelope, parseReceipt, verifyReceiptSignature, type Receipt } from "@agentproof/core";
import { flag, parseArgs, UsageError } from "../args.ts";
import { CliError, EXIT, readJson } from "../io.ts";
import { c } from "../terminal.ts";

export const VERIFY_RECEIPT_HELP = `agentproof verify-receipt <receipt.json | receipt.dsse.json> --public-key issuer.pub

Check that a receipt was issued by the holder of a key and not edited since.
Accepts a receipt file or its DSSE envelope (see docs/RECEIPT_SPEC.md).
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
  const input = await readJson(path);
  let receipt: Receipt;
  if (isDsseEnvelope(input)) {
    const opened = fromDsseEnvelope(input);
    if (!opened.ok) {
      // A malformed envelope is an invalid credential, not a usage error.
      console.log(`${c.red("✗")} not verified: the DSSE envelope is malformed (${opened.problems})`);
      return EXIT.BLOCK;
    }
    receipt = opened.receipt;
  } else {
    const parsed = parseReceipt(input);
    if (!parsed.ok) throw new CliError(`${path} is not a valid AgentProof receipt: ${parsed.problems}`);
    receipt = parsed.receipt;
  }
  let key: string;
  try {
    key = await readFile(keyPath, "utf8");
  } catch {
    throw new CliError(`cannot read public key ${keyPath}`);
  }
  let check;
  try {
    check = verifyReceiptSignature(receipt, key);
  } catch (error) {
    throw new CliError(`${keyPath} is not a usable Ed25519 public key: ${(error as Error).message}`);
  }
  if (!check.ok) {
    console.log(`${c.red("✗")} not verified: ${WHY[check.reason]}`);
    return EXIT.BLOCK;
  }
  console.log(`${c.green("✓")} receipt ${receipt.run_id} verified · key ${check.keyId} · decision ${receipt.decision} under ${receipt.policy.id}@${receipt.policy.version}`);
  return EXIT.ALLOW;
}
