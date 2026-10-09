import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiLaunch } from "../pi-extension/subagents/launcher.ts";

it("uses bin.pi from the manifest and preserves CLI/runtime paths containing spaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi launcher spaces "));
  try {
    mkdirSync(join(dir, "custom bin"));
    const cli = join(dir, "custom bin", "pi entry.js");
    const runtime = join(dir, "node runtime");
    writeFileSync(cli, "");
    writeFileSync(runtime, "");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: { pi: "custom bin/pi entry.js" } }));
    assert.deepEqual(resolvePiLaunch(dir, runtime), { command: runtime, prefix: [cli] });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: "custom bin/pi entry.js" }));
    assert.deepEqual(resolvePiLaunch(dir, runtime).prefix, [cli]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("gives actionable diagnostics for missing manifest, CLI and runtime", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi launcher missing "));
  try {
    assert.throws(() => resolvePiLaunch(dir), /Cannot launch Pi directly.*package.json/);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: { pi: "missing.js" } }));
    assert.throws(() => resolvePiLaunch(dir), /missing.js/);
    writeFileSync(join(dir, "missing.js"), "");
    assert.throws(() => resolvePiLaunch(dir, join(dir, "missing-runtime")), /missing-runtime/);
    writeFileSync(join(dir, "package.json"), "{}");
    assert.throws(() => resolvePiLaunch(dir), /no bin.pi entry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
