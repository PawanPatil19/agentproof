/**
 * `npm run demo:shop` — a shopping agent spends under an SGD limit through the
 * AgentProof MCP gateway. Writes signed receipts, the issuer's public key and a
 * deliberately edited receipt to examples/shopping-agent/out/.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { seal, verifyReceiptSignature, type Receipt } from "@agentproof/core";
import { FileReceiptStore } from "@agentproof/sdk";
import { runShopping, type Step } from "./shop.ts";

const OUT = fileURLToPath(new URL("../out", import.meta.url));
const show = relative(process.cwd(), OUT) || ".";

const color = process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const red = paint("31");
const badge = (d: Receipt["decision"]) => paint(d === "allow" ? "42;30;1" : d === "block" ? "41;37;1" : "43;30;1")(` ${d.toUpperCase()} `);
const sgd = (n: number) => `SGD ${n.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function describe(step: Step): string {
  if (step.tool === "payments.send") {
    const a = step.args as { merchant: string; amount: number; item: string };
    return `pay ${bold(a.merchant)} ${sgd(a.amount)} ${dim(`for ${a.item}`)}`;
  }
  if (step.tool === "catalog.search") return `search the catalog ${dim(`"${String(step.args.query)}"`)}`;
  return `${bold(step.tool)} ${dim(`(${step.why})`)}`;
}

function outcome(step: Step): string {
  if (step.decision === "allow") {
    const spent = step.spentToday !== undefined ? `  spent in the last 24h ${sgd(step.spentToday)} of 150` : "";
    return `${badge("allow")} ${green(step.executed ? "ran" : "")}${spent}`;
  }
  // Messages come from the guard: they name fields, limits and amounts, never string values like the merchant.
  const why = (step.reason ?? "").replace(/^'[^']+' /, "");
  return `${badge(step.decision)} ${red(step.reasonCode ?? "")} ${dim(why)}`;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const run = await runShopping({ store: new FileReceiptStore(OUT) });

console.log(bold("AgentProof · a shopping agent behind the MCP gateway"));
console.log(dim("policy household-shopping@1: SGD only · approved merchants · max SGD 80 a payment · SGD 150 per 24h"));
console.log(`\nagent sees tools: ${run.visibleTools.join(", ")}  ${dim("(wallet.export_keys hidden)")}\n`);

run.steps.forEach((step, i) => {
  console.log(`${dim(String(i + 1).padStart(2))}  ${describe(step)}`);
  console.log(`    ${outcome(step)}`);
});

const paid = run.payments.reduce((sum, p) => sum + p.amount, 0);
const stopped = run.steps.filter((s) => !s.executed).length;
console.log(`\n${bold("payments server received")} ${run.payments.length} payments, ${sgd(paid)} · key exports ${run.keyExports} · ${stopped} calls stopped before they ran`);

// Every call left a signed receipt. Check one, then show that an edit is caught.
await writeFile(join(OUT, "issuer.pub"), run.publicKeyPem);
const laptop = run.steps.find((s) => (s.args as { item?: string }).item === "Laptop")!.receipt;
// A careful forger re-seals the edit so its digest matches, and keeps the original signature.
// Only the signature can catch that.
const edited: Receipt = { ...seal({ ...laptop, decision: "allow", evaluated_decision: "allow", reason_codes: [] }), signature: laptop.signature! };
await writeFile(join(OUT, "laptop.json"), `${JSON.stringify(laptop, null, 2)}\n`);
await writeFile(join(OUT, "laptop-edited.json"), `${JSON.stringify(edited, null, 2)}\n`);

const check = verifyReceiptSignature(laptop, run.publicKeyPem);
const tampered = verifyReceiptSignature(edited, run.publicKeyPem);
console.log(`${bold(`${run.receipts.length} signed receipts`)} ${dim("(Ed25519 DSSE over in-toto)")} in ${show}/`);
console.log(`  laptop receipt          ${check.ok ? green(`✓ verified with issuer.pub · decision ${laptop.decision}`) : red("✗ failed")}`);
console.log(`  same, edited to "allow" ${tampered.ok ? red("✓ verified (unexpected)") : red(`✗ rejected (${tampered.reason}): the signature does not match the edit`)}`);
