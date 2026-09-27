#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!new Set(["test", "typecheck"]).has(mode)) throw new Error("Usage: with-pi-runtime.mjs <test|typecheck>");
const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeManifest = process.env.PI_RUNTIME_MANIFEST;
const manifest = (() => {
  if (runtimeManifest) return JSON.parse(readFileSync(runtimeManifest, "utf8"));
  const pi = spawnSync("which", ["pi"], { encoding: "utf8" });
  if (pi.error || pi.status !== 0 || !pi.stdout.trim()) throw new Error("PI_RUNTIME_MANIFEST is required when no runnable Pi launcher is on PATH");
  const discovered = spawnSync(process.execPath, [join(extensionDir, "scripts", "discover-pi-runtime.mjs"), pi.stdout.trim()], { encoding: "utf8" });
  if (discovered.error || discovered.status !== 0) throw discovered.error ?? new Error(`Unable to resolve the final Pi CLI closure: ${discovered.stderr.trim()}`);
  return JSON.parse(discovered.stdout);
})();
if (typeof manifest?.codingAgent?.root !== "string" || typeof manifest?.agentCore?.root !== "string") throw new Error("PI_RUNTIME_MANIFEST must describe the final Pi coding-agent and agent-core closure");
const runtime = resolve(manifest.codingAgent.root);
const core = resolve(manifest.agentCore.root);
if (!existsSync(join(runtime, "package.json")) || !existsSync(join(core, "package.json"))) throw new Error("Pi runtime manifest points to a missing package closure");
const runtimePackage = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8"));
const corePackage = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
if (runtimePackage.name !== "@earendil-works/pi-coding-agent" || corePackage.name !== "@earendil-works/pi-agent-core" || !existsSync(join(runtime, "dist/index.d.ts"))) throw new Error(`Invalid Pi runtime structural contract: ${runtime}`);
const localTypeScriptBin = join(extensionDir, "node_modules", "typescript", "bin", "tsc");
const typeScriptBin = process.env.PI_TYPESCRIPT_BIN || localTypeScriptBin;
if (mode === "typecheck") {
  if (!existsSync(typeScriptBin)) throw new Error(`TypeScript compiler not found at ${typeScriptBin}; run npm ci or set PI_TYPESCRIPT_BIN`);
  const result = spawnSync(typeScriptBin, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Unable to execute TypeScript compiler at ${typeScriptBin}`);
}
const runtimeNodeModules = join(runtime, "node_modules");
const dependencies = [["@earendil-works/pi-coding-agent", runtime], ["@earendil-works/pi-agent-core", core], ["@earendil-works/pi-ai", join(runtimeNodeModules, "@earendil-works/pi-ai")], ["typebox", join(runtimeNodeModules, "typebox")], ["@types/node", join(runtimeNodeModules, "@types/node")]];
for (const [, path] of dependencies) if (!existsSync(path)) throw new Error(`Installed Pi runtime is missing required resolver closure: ${path}`);
const created = [];
for (const [name, target] of dependencies) {
  const link = join(extensionDir, "node_modules", name);
  if (existsSync(link)) throw new Error(`Refusing to replace existing dependency resolver path: ${link}`);
  mkdirSync(dirname(link), { recursive: true }); symlinkSync(target, link, "dir"); created.push(link);
}
try {
  const command = mode === "test"
    ? ["bun", "test", "index.test.ts", "policy.test.ts", "session-state.test.ts", "summary.test.ts", "scripts/discover-pi-runtime.test.mjs", "audit.test.ts"]
    : [typeScriptBin, "-p", "tsconfig.json"];
  const result = spawnSync(command[0], command.slice(1), { cwd: extensionDir, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const link of created.reverse()) unlinkSync(link);
  for (const path of [join(extensionDir, "node_modules/@earendil-works"), join(extensionDir, "node_modules/@types"), join(extensionDir, "node_modules")]) try { rmdirSync(path); } catch {}
}
