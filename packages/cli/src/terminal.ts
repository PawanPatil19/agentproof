/** Terminal rendering of a receipt. Colors only on a TTY and never with NO_COLOR. */
import type { CheckResult, Decision, Receipt } from "@agentproof/core";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  inverse: (d: Decision) => paint(d === "allow" ? "42;30;1" : d === "block" ? "41;37;1" : "43;30;1"),
};

const ICON: Record<CheckResult["status"], string> = { pass: c.green("✓"), fail: c.red("✗"), unknown: c.yellow("?"), not_applicable: c.dim("–") };

export function formatReceipt(receipt: Receipt, paths: { receipt?: string; report?: string } = {}): string {
  const lines: string[] = [];
  const contract = receipt.contract ? ` · ${receipt.contract.name}@${receipt.contract.version} attempt ${receipt.contract.attempt}` : "";
  lines.push(c.bold(`AgentProof · run ${receipt.run_id}`) + c.dim(` · ${receipt.policy.id}@${receipt.policy.version}${contract} · ${receipt.mode}`));

  const shown = receipt.decision.toUpperCase();
  let banner = c.inverse(receipt.decision)(` ${shown} `);
  if (receipt.decision !== receipt.evaluated_decision) {
    banner += c.yellow(`  would ${receipt.evaluated_decision} in enforce mode`);
  }
  lines.push("", banner);

  const cov = receipt.coverage;
  lines.push(
    `  claims  ${cov.claims_passing}/${cov.claims_total} passing required checks`,
    `  checks  ${cov.checks.pass} pass · ${cov.checks.fail} fail · ${cov.checks.unknown} unknown · ${cov.checks.not_applicable} n/a` +
      c.dim(`  (${receipt.duration_ms} ms)`),
  );

  const notable = receipt.checks.filter((r) => r.status === "fail" || r.status === "unknown");
  if (notable.length > 0) {
    lines.push("");
    for (const r of notable) {
      const tag = r.required ? "" : c.dim(" advisory");
      lines.push(`  ${ICON[r.status]} ${r.check.padEnd(19)} ${c.dim(r.target.padEnd(18))}${tag} ${r.message}`);
    }
  }
  if (paths.receipt || paths.report) lines.push("");
  if (paths.receipt) lines.push(`  ${c.dim("receipt")} ${paths.receipt}`);
  if (paths.report) lines.push(`  ${c.dim("report ")} ${paths.report}`);
  return lines.join("\n");
}
