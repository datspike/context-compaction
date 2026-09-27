#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const requested = process.argv[2];
if (!requested) throw new Error("Usage: discover-pi-runtime.mjs <pi executable>");
const executable = realpathSync(requested);
const explicitFinalCli = process.env.PI_RUNTIME_FINAL_CLI;
function packageRoot(from) {
  let cursor = dirname(from);
  while (cursor !== dirname(cursor)) {
    const file = join(cursor, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") return cursor;
    }
    cursor = dirname(cursor);
  }
  throw new Error(`Cannot derive @earendil-works/pi-coding-agent package root from final CLI ${from}`);
}
// A shell wrapper is not a module realm. Its final CLI must be supplied
// explicitly; PATH may contain an unrelated `pi` and is never consulted here.
const finalCli = explicitFinalCli ? realpathSync(explicitFinalCli) : executable;
let codingAgentRoot;
try {
  codingAgentRoot = packageRoot(finalCli);
} catch {
  if (!explicitFinalCli) {
    throw new Error(`Cannot derive @earendil-works/pi-coding-agent from invoked executable ${requested}. For a shell wrapper, set PI_RUNTIME_FINAL_CLI to the executable it invokes; PATH is intentionally not searched.`);
  }
  throw new Error(`Cannot derive @earendil-works/pi-coding-agent from explicit PI_RUNTIME_FINAL_CLI=${explicitFinalCli}.`);
}
const agentCoreRoot = resolve(codingAgentRoot, "node_modules/@earendil-works/pi-agent-core");
for (const path of [join(codingAgentRoot, "dist/index.js"), join(agentCoreRoot, "dist/index.js")]) {
  if (!existsSync(path)) throw new Error(`Required installed Pi module is absent: ${path}`);
}
const coding = JSON.parse(readFileSync(join(codingAgentRoot, "package.json"), "utf8"));
const core = JSON.parse(readFileSync(join(agentCoreRoot, "package.json"), "utf8"));
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  invokedCli: requested,
  finalCli,
  explicitFinalCli: explicitFinalCli ?? null,
  codingAgent: { package: coding.name, version: coding.version, root: codingAgentRoot, moduleUrl: new URL(`file://${join(codingAgentRoot, "dist/index.js")}`).href, export: "AgentSession" },
  agentCore: { package: core.name, version: core.version, root: agentCoreRoot, moduleUrl: new URL(`file://${join(agentCoreRoot, "dist/index.js")}`).href, export: "Agent" },
}, null, 2)}\n`);
