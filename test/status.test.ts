import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseStatusConfig, createStatusState, observeStatus, advanceStatusState, formatStatusAggregate } from "../pi-extension/subagents/status.ts";
import { parseSubagentConfig } from "../pi-extension/subagents/config.ts";
import { StatusMonitor } from "../pi-extension/subagents/status-monitor.ts";
import { formatAgentRows } from "../pi-extension/subagents/view.ts";

it("retains the Psmux example configuration and status/model defaults", () => {
  const example = JSON.parse(readFileSync(new URL("../config.json.example", import.meta.url), "utf8"));
  assert.deepEqual(example, { status: { enabled: true }, models: { agents: {} } });
  assert.deepEqual(parseStatusConfig(example), { enabled: true, lineLimit: 4 });
  assert.deepEqual(parseSubagentConfig(example).models, { agents: {}, validate: true, fallback: "inherit" });
  assert.equal(parseSubagentConfig({ status: { enabled: false } }).models, null);
  assert.equal(parseStatusConfig({ status: { enabled: false } }).enabled, false);
});

it("retains original status validation instead of silently ignoring settings", () => {
  assert.throws(() => parseStatusConfig({}), /status must be an object/);
  assert.throws(() => parseStatusConfig({ status: { enabled: "false" } }), /status.enabled must be a boolean/);
  assert.throws(() => parseStatusConfig({ status: { enabled: true, lineLimit: 8 } }), /unsupported key/);
});

it("retains the original 60-second stall/recovery classifier and notification cap", () => {
  const state = createStatusState({ source: "pi", startTimeMs: 0 });
  assert.equal(advanceStatusState(state, 59999).transition, null);
  const stalled = advanceStatusState(state, 60000);
  assert.equal(stalled.transition, "stalled");
  const observed = observeStatus(stalled.nextState, { snapshot: "present", updatedAt: 60001, sequence: 1, phase: "active" }, 60001);
  assert.equal(advanceStatusState(observed, 60001).transition, "recovered");
  assert.match(formatStatusAggregate(["one", "two", "three", "four", "five"], 4), /four/);
  assert.ok(!formatStatusAggregate(["one", "two", "three", "four", "five"], 4).includes("five"));
});

it("uses RPC observations while preserving interactive suppression and recovery", async () => {
  let now = 0, healthy = false;
  const monitor = new StatusMonitor(() => now);
  const make = (interactive: boolean, name: string): any => ({ live: true, startedAt: 0, phase: "running", activity: "working", interactive, name,
    rpc: { request: async () => { if (!healthy) throw new Error("unresponsive"); return {}; } } });
  const autonomous = make(false, "autonomous"), interactive = make(true, "interactive");
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  monitor.tick([autonomous, interactive]); await flush();
  now = 60000;
  const stalled = monitor.tick([autonomous, interactive]); await flush();
  assert.equal(stalled.length, 1);
  assert.match(stalled[0], /autonomous.*stalled/);
  assert.equal(interactive.statusKind, "stalled");
  healthy = true; now++;
  monitor.tick([autonomous, interactive]); await flush();
  const recovered = monitor.tick([autonomous, interactive]); await flush();
  assert.equal(recovered.length, 1);
  assert.match(recovered[0], /autonomous.*recovered/);
  monitor.clear();
});

it("status.enabled=false suppresses detailed activity but retains agent navigation", () => {
  const agent: any = { depth: 0, name: "one", agent: "scout", phase: "running", activity: "provider retry", elapsed: 2 };
  assert.ok(formatAgentRows([agent], 100).join("").includes("provider retry"));
  const disabled = formatAgentRows([agent], 100, false).join("");
  assert.ok(!disabled.includes("provider retry"));
  assert.ok(disabled.includes("one"));
});
