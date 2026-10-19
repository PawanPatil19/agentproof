/**
 * Command-line wiring: read flags, start the upstream server as a child
 * process, and serve the gateway on stdio. stdout carries the MCP protocol,
 * so everything human-readable goes to stderr.
 */
import { readFile } from "node:fs/promises";
import type { Mode } from "@agentproof/core";
import { createVerifier, FileReceiptStore } from "@agentproof/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGateway, type Gateway } from "./gateway.ts";
import { GATEWAY_VERSION } from "./version.ts";

export const GATEWAY_HELP = `agentproof-mcp-gateway ${GATEWAY_VERSION} — enforce an AgentProof contract on every MCP tool call

Usage: agentproof-mcp-gateway --policy <file> --contract <name> --worker <id> [options] -- <command> [args...]

  --policy <file>        agentproof.yaml to enforce (required)
  --contract <name>      contract in the policy that every call runs under (required)
  --worker <id>          trusted identity of the agent using this gateway (required)
  --coordinator <id>     identity issuing the contract (default: gateway://agentproof)
  --mode <m>             observe | enforce (default: the policy's mode)
  --receipts <dir>       where receipts are written (default: agentproof-reports)
  --signing-key <file>   Ed25519 private key (PKCS#8 PEM) to sign each receipt
  --task-prefix <id>     prefix for per-call task IDs (default: random)
  --list-all-tools       list tools the contract refuses (hidden in enforce mode by default)

Everything after -- starts the upstream MCP server over stdio. The agent connects to this
process over stdio as if it were that server.`;

export interface GatewayConfig {
  policyFile: string;
  contract: string;
  worker: string;
  coordinator: string;
  mode?: Mode;
  receiptsDir?: string;
  signingKeyFile?: string;
  taskPrefix?: string;
  listAllTools: boolean;
  command: string;
  args: string[];
}

export class GatewayUsageError extends Error {}

const VALUE_FLAGS = new Set(["policy", "contract", "worker", "coordinator", "mode", "receipts", "signing-key", "task-prefix"]);

export function parseGatewayArgs(argv: string[]): GatewayConfig {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const upstream = split === -1 ? [] : argv.slice(split + 1);
  const values: Record<string, string> = {};
  let listAllTools = false;
  for (let i = 0; i < own.length; i++) {
    const arg = own[i] as string;
    if (!arg.startsWith("--")) throw new GatewayUsageError(`unexpected argument '${arg}' (put the upstream command after --)`);
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (name === "list-all-tools") listAllTools = true;
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? own[++i];
      if (value === undefined || value.startsWith("--")) throw new GatewayUsageError(`--${name} needs a value`);
      values[name] = value;
    } else throw new GatewayUsageError(`unknown option --${name}`);
  }
  for (const required of ["policy", "contract", "worker"]) {
    if (!values[required]) throw new GatewayUsageError(`--${required} is required`);
  }
  const mode = values.mode;
  if (mode !== undefined && mode !== "observe" && mode !== "enforce") throw new GatewayUsageError("--mode must be observe or enforce");
  const [command, ...args] = upstream;
  if (!command) throw new GatewayUsageError("no upstream server command; add -- <command> [args...]");
  return {
    policyFile: values.policy as string,
    contract: values.contract as string,
    worker: values.worker as string,
    coordinator: values.coordinator ?? "gateway://agentproof",
    ...(mode ? { mode } : {}),
    ...(values.receipts ? { receiptsDir: values.receipts } : {}),
    ...(values["signing-key"] ? { signingKeyFile: values["signing-key"] } : {}),
    ...(values["task-prefix"] ? { taskPrefix: values["task-prefix"] } : {}),
    listAllTools,
    command,
    args,
  };
}

/** Start the upstream server and serve the gateway on this process's stdio. */
export async function runGateway(config: GatewayConfig): Promise<Gateway> {
  const verifier = await createVerifier({
    policyFile: config.policyFile,
    ...(config.mode ? { mode: config.mode } : {}),
    store: new FileReceiptStore(config.receiptsDir),
    ...(config.signingKeyFile ? { signingKeyPem: await readFile(config.signingKeyFile, "utf8") } : {}),
  });

  const upstream = new Client({ name: "agentproof-mcp-gateway", version: GATEWAY_VERSION });
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  await upstream.connect(new StdioClientTransport({ command: config.command, args: config.args, env, stderr: "inherit" }));

  const gateway = createGateway({
    verifier,
    upstream,
    contract: config.contract,
    worker: config.worker,
    coordinator: config.coordinator,
    listAllTools: config.listAllTools,
    ...(config.taskPrefix ? { taskPrefix: config.taskPrefix } : {}),
  });
  const transport = new StdioServerTransport();
  // When the agent goes away, take the upstream server down with it.
  transport.onclose = () => void upstream.close().catch(() => undefined);
  upstream.onclose = () => void gateway.close().catch(() => undefined);
  await gateway.connect(transport);
  console.error(`agentproof-mcp-gateway: ${verifier.mode} mode, policy ${verifier.policy.id}@${verifier.policy.version}, contract '${config.contract}', worker ${config.worker}`);
  return gateway;
}
