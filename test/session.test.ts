import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSubagentSessionFile, getSessionId, getNewEntries, getActiveSessionEntries, readNameRegistry, registerName, readSubagentLoadout, writeSubagentLoadout, summarizeSessionStats } from "../pi-extension/subagents/session.ts";

it("persists session lineage, loadout, registry, history and usage with space-containing paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi session test "));
  try {
    const parent = join(dir, "parent.jsonl");
    const child = join(dir, "child.jsonl");
    writeFileSync(parent, JSON.stringify({ type: "session", id: "parent", version: 3 }) + "\n");
    seedSubagentSessionFile({ mode: "lineage-only", parentSessionFile: parent, childSessionFile: child, childCwd: dir });
    const header = getNewEntries(child, 0)[0];
    assert.equal(header.parentSession, parent);
    assert.equal(getSessionId(child), header.id);
    const loadout = { agent: "worker", toolAllowlist: "read,ask_question", model: "inherit", thinking: "medium", systemPromptMode: "append" as const, identity: "You are a worker.", spawnable: null, autoExit: true, cwd: dir, agentDir: dir };
    writeSubagentLoadout(child, loadout);
    assert.deepEqual(readSubagentLoadout(child), loadout);
    registerName(dir, "worker", { sessionFile: child, sessionId: getSessionId(child) });
    assert.equal(readNameRegistry(dir).worker.sessionFile, child);
    const message = { type: "message", id: "m", message: { role: "assistant", model: "model", content: [{ type: "text", text: "Done" }, { type: "toolCall", id: "call", name: "read" }], usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 180, cost: { total: 0.02 } } } };
    writeFileSync(child, readFileSync(child, "utf8") + JSON.stringify(message) + "\n");
    const stats = summarizeSessionStats(child)!;
    assert.equal(stats.model, "model");
    assert.equal(stats.toolCount, 1);
    assert.equal(stats.cost, 0.02);
    assert.equal(stats.inputTokens, 100);
    assert.equal(stats.contextTokens, 180);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("forks only the active branch before the dispatching user turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-fork-"));
  try {
    const parent = join(dir, "parent.jsonl");
    const child = join(dir, "child.jsonl");
    const entries = [
      { type: "session", id: "s", version: 3 },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "old task" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } },
      { type: "message", id: "abandoned", parentId: "a1", message: { role: "user", content: "abandoned task" } },
      { type: "message", id: "active", parentId: "a1", message: { role: "user", content: "dispatch task" } },
    ];
    writeFileSync(parent, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.deepEqual(getActiveSessionEntries(parent).map((e) => e.id), ["u1", "a1", "active"]);
    seedSubagentSessionFile({ mode: "fork", parentSessionFile: parent, childSessionFile: child, childCwd: dir });
    assert.deepEqual(getNewEntries(child, 0).slice(1).map((e) => e.id), ["u1", "a1"]);
    writeFileSync(child + ".loadout.json", "{}");
    assert.equal(readSubagentLoadout(child), null, "malformed snapshots must never become unrestricted resumes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("tolerates a partial last session record after a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-partial-"));
  try {
    const file = join(dir, "partial.jsonl");
    writeFileSync(file, '{"type":"session","id":"s"}\n{"type":');
    assert.equal(getNewEntries(file, 0).length, 1);
    writeFileSync(file, '{"type":"session","id":"s"}\nBAD\n{"type":"message"}\n');
    assert.throws(() => getNewEntries(file, 0));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
