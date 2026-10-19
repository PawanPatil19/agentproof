#!/usr/bin/env node
import { PolicyError } from "@agentproof/core";
import { GatewayConfigError } from "./gateway.ts";
import { GATEWAY_HELP, GatewayUsageError, parseGatewayArgs, runGateway } from "./run.ts";
import { GATEWAY_VERSION } from "./version.ts";

const argv = process.argv.slice(2);
const own = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;

if (own.includes("--help") || own.includes("-h") || argv.length === 0) {
  console.log(GATEWAY_HELP);
} else if (own.includes("--version") || own.includes("-v")) {
  console.log(GATEWAY_VERSION);
} else {
  try {
    await runGateway(parseGatewayArgs(argv));
  } catch (error) {
    if (error instanceof GatewayUsageError) console.error(`agentproof-mcp-gateway: ${error.message}\n\n${GATEWAY_HELP}`);
    else if (error instanceof PolicyError || error instanceof GatewayConfigError) console.error(`agentproof-mcp-gateway: ${error.message}`);
    else console.error(`agentproof-mcp-gateway: ${(error as Error).stack ?? error}`);
    process.exitCode = 3;
  }
}
