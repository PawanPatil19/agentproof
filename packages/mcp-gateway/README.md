# @agentproof/mcp-gateway

Put AgentProof in front of any MCP server. The gateway is an MCP server that
proxies one upstream MCP server. Every tool call runs under an AgentProof
contract before it reaches the upstream server, and every call leaves a
receipt. The agent needs no AgentProof code; point its MCP config at the
gateway instead of the server.

```
agent ──MCP──▶ agentproof-mcp-gateway ──MCP──▶ upstream server
                      │
                      └─ contract → tool guard → receipt (allow / block / review)
```

## Run it

```bash
agentproof-mcp-gateway \
  --policy agentproof.yaml \
  --contract agent_tools \
  --worker agent://assistant-1 \
  --receipts ./agentproof-reports \
  --signing-key ./agentproof-signing.key \
  -- npx -y @modelcontextprotocol/server-filesystem ./docs
```

In an MCP client config, the gateway replaces the server's command:

```json
{
  "mcpServers": {
    "docs": {
      "command": "agentproof-mcp-gateway",
      "args": ["--policy", "agentproof.yaml", "--contract", "agent_tools", "--worker", "agent://assistant-1",
               "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "./docs"]
    }
  }
}
```

Each upstream call is given the contract's `deadline_ms` as its timeout, and
an agent's cancellation is passed through. The gateway exits when the agent
closes its stdin, and exits with code 1 if the upstream server dies.

`--worker` is the identity the receipts name. The operator sets it, never the
agent. Run one gateway per agent identity.

## Policy

A gateway contract gates tool calls, not deliverables, so its policy needs no
claims and the contract has no `output_schema`. The gateway refuses to start
if either is set, because they would block every call.

```yaml
api_version: agentproof/v1
policy: { id: assistant-tools, version: 1 }
mode: enforce
registry:
  tools: [read_file, list_directory, write_file]
checks:
  evidence:
    min_claims: 0                # tool calls carry no claims
contracts:
  agent_tools:
    version: 1
    coordinator: operator
    worker: assistant
    deadline_ms: 30000           # per call: a result that arrives later is withheld
    allowed_tools: [read_file, list_directory]
enforcement:
  on_required_check_fail: block  # or review, to hold refused calls for a person
```

## What the agent gets back

| Receipt decision | Result |
| --- | --- |
| `allow` | The upstream result, unchanged. |
| `block` | An error result naming the reason codes. A refused call is never sent upstream; a result that fails the contract afterwards (deadline) is withheld. |
| `review` | An error result saying the call needs a person's approval before it is retried. A refused call is not sent upstream. |

Every result carries a receipt summary in `_meta["agentproof/receipt"]`:
decision, evaluated decision, mode, run and task IDs, receipt hash and reason
codes. The full receipt goes to the receipt store (and is signed when a key is
set). The receipt's output hash binds the tool name, a hash of the arguments
and a hash of the result.

In `observe` mode every call goes through and the receipt records what
enforcement would have done. In `enforce` mode, tools the contract refuses are
also hidden from `tools/list` (`--list-all-tools` turns that off).

## Library use

```ts
import { createVerifier } from "@agentproof/sdk";
import { createGateway } from "@agentproof/mcp-gateway";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const upstream = new Client({ name: "gateway", version: "0.1.0" });
await upstream.connect(new StdioClientTransport({ command: "my-mcp-server" }));
const verifier = await createVerifier({ policyFile: "./agentproof.yaml" });
const gateway = createGateway({ verifier, upstream, contract: "agent_tools", worker: "agent://assistant-1", coordinator: "gateway://operator" });
await gateway.connect(new StdioServerTransport()); // or any MCP server transport
```

`gateway.callTool(name, args)` runs one call through the gate directly and
returns the decision, the receipt, whether the tool ran, and the MCP result.

## Limits

- Tools only. Resources, prompts and sampling are not forwarded, since they
  would bypass the gate.
- A `review` outcome cannot yet be approved in-band. The call is refused, the
  receipt records that it needs a person, and the agent retries once cleared.
- Each call's contract attempt and receipt stay in the verifier's memory for
  the life of the process, so a very long-lived gateway slowly grows. Restart
  it periodically until the SDK can release settled attempts.
- The gateway trusts its own configuration. Anyone who can change its flags
  or policy file can change what it enforces.
