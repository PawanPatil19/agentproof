/**
 * Local HTML report. One self-contained file: no scripts, no external
 * assets, no tracking. Every captured string is escaped, and links are only
 * emitted for http(s) locators — the report is safe to open on hostile input.
 *
 * It answers four questions: what was decided, why, against which
 * obligation, and what can happen next.
 */
import type { CheckResult, CheckStatus, Receipt } from "../types.ts";
import { classifyLocator } from "../util/text.ts";
import { REASON_TEXT } from "./reasons.ts";

export interface ClaimText {
  text: string;
  quote?: string;
}

export interface ReportOptions {
  /** Claim text and quotes from the original run file, keyed by claim ID. Shown only locally. */
  claimText?: Map<string, ClaimText>;
}

const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STATUS_LABEL: Record<CheckStatus, string> = { pass: "Pass", fail: "Fail", unknown: "Unknown", not_applicable: "N/A" };

const STATUSES: readonly CheckStatus[] = ["pass", "fail", "unknown", "not_applicable"];
/** Class names come from a fixed set, never from the receipt. */
const statusClass = (status: unknown): CheckStatus => (STATUSES.includes(status as CheckStatus) ? (status as CheckStatus) : "unknown");
const num = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

const pill = (status: CheckStatus) => `<span class="pill ${statusClass(status)}">${STATUS_LABEL[statusClass(status)]}</span>`;

const short = (hash?: string) => (hash ? `${esc(hash.replace(/^sha256:/, "").slice(0, 12))}…` : "—");

function locatorCell(locator?: string): string {
  if (!locator) return "—";
  return classifyLocator(locator) === "url"
    ? `<a href="${esc(locator)}" rel="noopener noreferrer nofollow" target="_blank">${esc(locator)}</a>`
    : `<code>${esc(locator)}</code>`;
}

function checkRow(r: CheckResult): string {
  return `<tr>
    <td><code>${esc(r.check)}</code>${r.required ? "" : ` <span class="tag">advisory</span>`}</td>
    <td><code class="muted">${esc(r.target)}</code></td>
    <td>${pill(r.status)}</td>
    <td>${esc(r.message)}</td>
  </tr>`;
}

function headline(receipt: Receipt): { title: string; detail: string } {
  const d = receipt.evaluated_decision;
  if (receipt.mode === "observe" && d !== "allow") {
    return { title: `Would ${d} — observe mode`, detail: "Work continued. In enforce mode the host would have stopped here." };
  }
  if (d === "allow") return { title: "Allowed", detail: "Every required check passed under this policy." };
  if (d === "review") return { title: "Sent to review", detail: "A required check could not reach a conclusion. Nothing is released until a reviewer approves this exact output." };
  return { title: "Blocked", detail: "A required check failed. The deliverable must not be consumed or released." };
}

export function renderReport(receipt: Receipt, options: ReportOptions = {}): string {
  const text = options.claimText ?? new Map<string, ClaimText>();
  const c0 = receipt.coverage;
  const cov = {
    claims_total: num(c0.claims_total),
    claims_with_evidence: num(c0.claims_with_evidence),
    claims_passing: num(c0.claims_passing),
    checks: { pass: num(c0.checks.pass), fail: num(c0.checks.fail), unknown: num(c0.checks.unknown), not_applicable: num(c0.checks.not_applicable) },
  };
  const total = Math.max(receipt.checks.length, 1);
  const { title, detail } = headline(receipt);
  const tone = (["allow", "block", "review"] as const).find((d) => d === receipt.evaluated_decision) ?? "block";
  const showsText = receipt.claims.some((c) => c.text !== undefined || text.has(c.id));

  const claimChecks = (id: string) => receipt.checks.filter((r) => r.target === `claim:${id}`);
  const boundaryChecks = receipt.checks.filter((r) => !r.target.startsWith("claim:"));

  const claims = receipt.claims
    .map((claim) => {
      const t = text.get(claim.id);
      const body = claim.text ?? t?.text;
      const results = claimChecks(claim.id);
      const cls = statusClass(claim.status);
      return `<details class="claim ${cls}"${cls === "fail" || cls === "unknown" ? " open" : ""}>
  <summary>
    ${pill(claim.status)}
    <span class="claim-id">${esc(claim.id)}</span>
    <span class="claim-text">${body !== undefined ? esc(body) : `<span class="muted">text not captured · sha256 ${short(claim.text_sha256)}</span>`}</span>
  </summary>
  <div class="claim-body">
    ${t?.quote ? `<blockquote>${esc(t.quote)}</blockquote>` : ""}
    <p class="chips">${claim.evidence_ids.length ? claim.evidence_ids.map((e) => `<span class="chip">${esc(e)}</span>`).join("") : `<span class="muted">No evidence cited</span>`}</p>
    <ul class="results">${results
      .map((r) => `<li>${pill(r.status)} <code>${esc(r.check)}</code>${r.required ? "" : ` <span class="tag">advisory</span>`} <span>${esc(r.message)}</span></li>`)
      .join("")}</ul>
  </div>
</details>`;
    })
    .join("\n");

  const reasons = receipt.reason_codes.length
    ? `<ul class="reasons">${receipt.reason_codes.map((r) => `<li><code>${esc(r)}</code> ${esc(REASON_TEXT[r] ?? r)}</li>`).join("")}</ul>`
    : "";

  const tools = receipt.tool_events.length
    ? `<ol class="timeline">${receipt.tool_events
        .map(
          (e) =>
            `<li class="${e.outcome === "blocked" ? "blocked" : e.reason ? "flagged" : ""}"><code>${esc(e.tool)}</code> <span class="muted">by ${esc(e.agent)}${e.at ? ` · ${esc(e.at)}` : ""}</span> <span class="tag">${esc(e.outcome ?? "invoked")}</span>${e.reason ? `<div class="muted">${esc(e.reason)}</div>` : ""}</li>`,
        )
        .join("")}</ol>`
    : `<p class="muted">No tool calls were observed at guarded boundaries.</p>`;

  const evidence = receipt.evidence.length
    ? `<div class="table"><table><thead><tr><th>ID</th><th>Source</th><th>Locator</th><th>Published</th><th>Content hash</th></tr></thead><tbody>${receipt.evidence
        .map((e) => `<tr><td><code>${esc(e.id)}</code></td><td>${esc(e.source_id ?? "—")}</td><td>${locatorCell(e.locator)}</td><td>${esc(e.published_at ?? "—")}</td><td><code class="muted">${short(e.content_sha256)}</code></td></tr>`)
        .join("")}</tbody></table></div>`
    : `<p class="muted">No evidence records were supplied.</p>`;

  const bar = (["pass", "fail", "unknown", "not_applicable"] as CheckStatus[])
    .filter((s) => cov.checks[s] > 0)
    .map((s) => `<span class="seg ${s}" style="width:${((cov.checks[s] / total) * 100).toFixed(2)}%"></span>`)
    .join("");

  const contract = receipt.contract;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
<title>AgentProof · ${esc(receipt.run_id)}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="top"><div class="wrap"><span class="brand"><span class="logo">✓</span>AgentProof</span><span class="muted">Local report · generated offline</span></div></header>
<main class="wrap">
  <section class="hero ${tone}">
    <div class="eyebrow">Run ${esc(receipt.run_id)}${receipt.task_id ? ` · task ${esc(receipt.task_id)}` : ""} · ${esc(receipt.boundary.replace("_", " "))}</div>
    <h1>${esc(title)}</h1>
    <p>${esc(detail)}</p>
    ${reasons}
    <div class="meta">
      <span>policy <b>${esc(receipt.policy.id)}@${esc(receipt.policy.version)}</b></span>
      ${contract ? `<span>contract <b>${esc(contract.name)}@${esc(contract.version)}</b> · attempt ${esc(contract.attempt)}</span><span>worker <b>${esc(contract.worker)}</b> → coordinator <b>${esc(contract.coordinator)}</b></span>` : ""}
      <span>mode <b>${esc(receipt.mode)}</b></span>
    </div>
  </section>

  <section class="metrics">
    <div class="metric"><strong>${cov.claims_passing} / ${cov.claims_total}</strong><span>claims passing required checks</span></div>
    <div class="metric"><strong>${cov.claims_with_evidence} / ${cov.claims_total}</strong><span>claims citing evidence</span></div>
    <div class="metric"><strong>${cov.checks.fail}</strong><span>failed checks</span></div>
    <div class="metric"><strong>${cov.checks.unknown}</strong><span>inconclusive checks</span></div>
    <div class="metric"><strong>${esc(receipt.duration_ms)} ms</strong><span>verifier time</span></div>
  </section>
  <div class="bar" role="img" aria-label="${cov.checks.pass} pass, ${cov.checks.fail} fail, ${cov.checks.unknown} unknown, ${cov.checks.not_applicable} not applicable">${bar}</div>
  <p class="legend"><span><i class="dot pass"></i>${cov.checks.pass} pass</span><span><i class="dot fail"></i>${cov.checks.fail} fail</span><span><i class="dot unknown"></i>${cov.checks.unknown} unknown</span><span><i class="dot not_applicable"></i>${cov.checks.not_applicable} n/a</span></p>

  <section>
    <h2>Claims</h2>
    ${claims || `<p class="muted">The output declared no claims. AgentProof v1 checks explicit claims in <code>output.claims</code>.</p>`}
  </section>

  <section>
    <h2>Boundary checks</h2>
    ${boundaryChecks.length ? `<div class="table"><table><thead><tr><th>Check</th><th>Target</th><th>Result</th><th>Why</th></tr></thead><tbody>${boundaryChecks.map(checkRow).join("")}</tbody></table></div>` : `<p class="muted">No boundary-level checks applied.</p>`}
  </section>

  <section class="cols">
    <div><h2>Tool calls</h2>${tools}</div>
    <div><h2>Evidence</h2>${evidence}</div>
  </section>

  <footer>
    <p><b>What “pass” means:</b> the recorded checks passed under policy <code>${esc(receipt.policy.id)}@${esc(receipt.policy.version)}</code>. A found quote proves the source contains that text — not that the claim is true or the source is right.</p>
    <p class="muted">checker ${esc(receipt.checker_version)} · policy ${short(receipt.policy.digest)} · output ${short(receipt.output_sha256)} · receipt ${short(receipt.receipt_sha256)} · ${esc(receipt.created_at)}</p>
    ${showsText ? `<p class="muted">This local report includes claim text from the run file. The receipt JSON stores hashes only unless <code>privacy.capture: claims</code>.</p>` : ""}
  </footer>
</main>
</body>
</html>
`;
}

const STYLES = `
:root{--bg:#f5f5f0;--paper:#fff;--ink:#192d29;--muted:#5b6d66;--line:#d8e1d9;--green:#146b50;--lime:#dcf489;--dark:#122e27;
--pass:#2b815b;--pass-bg:#e3efdf;--fail:#a83b3b;--fail-bg:#f9e3e3;--unknown:#875414;--unknown-bg:#f7ebcf;--na:#5a6977;--na-bg:#e9edf0;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1714;--paper:#16211d;--ink:#e4ede7;--muted:#9bb0a6;--line:#2a3a33;--green:#7fd1a8;--dark:#0b2a21;
--pass:#7fd1a8;--pass-bg:#173528;--fail:#f0a0a0;--fail-bg:#3a1c1c;--unknown:#f0c070;--unknown-bg:#3a2d14;--na:#a9b5c0;--na-bg:#232c33;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding-inline:20px}code{font:12.5px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
a{color:var(--green);overflow-wrap:anywhere}.muted{color:var(--muted)}
.top{background:var(--paper);border-bottom:1px solid var(--line)}.top .wrap{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-block:14px;flex-wrap:wrap;font-size:13px}
.brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:19px;letter-spacing:-.5px}.logo{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:#146b50;color:#dcf489}
main{padding-block:28px 60px}
.hero{border-radius:20px;padding:30px 32px;background:#122e27;color:#fff;border-top:6px solid var(--pass)}
.hero.block{border-top-color:#d76a6a}.hero.review{border-top-color:#e2b04f}.hero.allow{border-top-color:#9ed36a}
.hero h1{margin:4px 0 6px;font-size:clamp(28px,4vw,42px);letter-spacing:-1.2px;line-height:1.1}.hero p{margin:0;color:#d3e2d8;max-width:720px}
.eyebrow{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#dcf489;font-weight:700}
.reasons{margin:16px 0 0;padding:0;list-style:none;display:grid;gap:6px}.reasons li{background:#ffffff14;border-radius:8px;padding:7px 12px;font-size:14px}.reasons code{color:#dcf489;margin-right:8px}
.meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:18px;font-size:12.5px;color:#b9cec1}.meta b{color:#fff;font-weight:650}
.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:18px 0 0}
.metric{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.metric strong{display:block;font-size:24px;letter-spacing:-.8px}.metric span{font-size:12px;color:var(--muted)}
.bar{display:flex;height:10px;border-radius:10px;overflow:hidden;margin:18px 0 6px;background:var(--line)}.seg.pass{background:var(--pass)}.seg.fail{background:var(--fail)}.seg.unknown{background:var(--unknown)}.seg.not_applicable{background:var(--na)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin:0}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.dot.pass{background:var(--pass)}.dot.fail{background:var(--fail)}.dot.unknown{background:var(--unknown)}.dot.not_applicable{background:var(--na)}
h2{font-size:20px;letter-spacing:-.4px;margin:34px 0 12px}
.pill{display:inline-block;min-width:62px;text-align:center;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:750;letter-spacing:.3px;text-transform:uppercase}
.pill.pass{background:var(--pass-bg);color:var(--pass)}.pill.fail{background:var(--fail-bg);color:var(--fail)}.pill.unknown{background:var(--unknown-bg);color:var(--unknown)}.pill.not_applicable{background:var(--na-bg);color:var(--na)}
.tag{font-size:10.5px;border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.claim{background:var(--paper);border:1px solid var(--line);border-left:4px solid var(--na);border-radius:12px;margin-bottom:10px}
.claim.pass{border-left-color:var(--pass)}.claim.fail{border-left-color:var(--fail)}.claim.unknown{border-left-color:var(--unknown)}
.claim summary{display:flex;gap:12px;align-items:baseline;padding:14px 16px;cursor:pointer;list-style:none}.claim summary::-webkit-details-marker{display:none}
.claim-id{font:12px ui-monospace,monospace;color:var(--muted)}.claim-text{flex:1;min-width:0}
.claim-body{padding:0 16px 14px 16px;border-top:1px dashed var(--line)}
blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--green);background:var(--bg);border-radius:0 8px 8px 0;font-style:italic}
.chips{margin:10px 0}.chip{display:inline-block;font:12px ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 8px;margin-right:6px}
.results{list-style:none;padding:0;margin:0;display:grid;gap:6px;font-size:14px}.results li{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.table{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--paper)}
table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:560px}th{text-align:left;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);background:var(--bg)}
th,td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}td:first-child code{overflow-wrap:normal;white-space:nowrap}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);gap:24px}
.timeline{list-style:none;margin:0;padding:0 0 0 16px;border-left:2px solid var(--line);display:grid;gap:10px}.timeline li{position:relative;font-size:14px}
.timeline li::before{content:"";position:absolute;left:-22px;top:7px;width:10px;height:10px;border-radius:50%;background:var(--pass)}.timeline li.blocked::before{background:var(--fail)}.timeline li.flagged::before{background:var(--unknown)}
footer{margin-top:40px;border-top:1px solid var(--line);padding-top:16px;font-size:13px}footer p{margin:0 0 8px}
@media (max-width:860px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.cols{grid-template-columns:1fr}.hero{padding:24px 20px}.claim summary{flex-wrap:wrap}}
`;
