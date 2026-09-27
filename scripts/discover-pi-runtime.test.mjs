import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = join(fileURLToPath(new URL(".", import.meta.url)), "discover-pi-runtime.mjs");

function runtime(root, version) {
	mkdirSync(join(root, "dist"), { recursive: true });
	mkdirSync(join(root, "node_modules", "@earendil-works", "pi-agent-core", "dist"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
	writeFileSync(join(root, "dist", "index.js"), "");
	writeFileSync(join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
	writeFileSync(join(root, "node_modules", "@earendil-works", "pi-agent-core", "package.json"), JSON.stringify({ name: "@earendil-works/pi-agent-core", version }));
	writeFileSync(join(root, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js"), "");
	return join(root, "dist", "cli.js");
}

test("explicit final CLI wins over a different pi on PATH behind a wrapper", () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-runtime-discovery-"));
	try {
		const intended = runtime(join(temp, "intended"), "1.0.0");
		const otherRoot = join(temp, "other");
		runtime(otherRoot, "2.0.0");
		mkdirSync(join(otherRoot, "bin"), { recursive: true });
		writeFileSync(join(otherRoot, "bin", "pi"), "#!/usr/bin/env node\n");
		chmodSync(join(otherRoot, "bin", "pi"), 0o755);
		const wrapper = join(temp, "wrapper-pi");
		writeFileSync(wrapper, "#!/usr/bin/env bash\nexec pi \"$@\"\n");
		chmodSync(wrapper, 0o755);
		const result = spawnSync(process.execPath, [script, wrapper], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${join(otherRoot, "bin")}:${process.env.PATH}`, PI_RUNTIME_FINAL_CLI: intended },
		});
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(result.stdout);
		assert.equal(manifest.finalCli, intended);
		assert.equal(manifest.codingAgent.version, "1.0.0");
		assert.notEqual(manifest.codingAgent.root, otherRoot);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("wrapper without explicit final CLI fails instead of rediscovering PATH pi", () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-runtime-discovery-"));
	try {
		const otherRoot = join(temp, "other");
		runtime(otherRoot, "2.0.0");
		mkdirSync(join(otherRoot, "bin"), { recursive: true });
		writeFileSync(join(otherRoot, "bin", "pi"), "#!/usr/bin/env node\n");
		chmodSync(join(otherRoot, "bin", "pi"), 0o755);
		const wrapper = join(temp, "wrapper-pi");
		writeFileSync(wrapper, "#!/usr/bin/env bash\nexec pi \"$@\"\n");
		chmodSync(wrapper, 0o755);
		const result = spawnSync(process.execPath, [script, wrapper], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${join(otherRoot, "bin")}:${process.env.PATH}`, PI_RUNTIME_FINAL_CLI: "" },
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /PI_RUNTIME_FINAL_CLI.*PATH is intentionally not searched/);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
