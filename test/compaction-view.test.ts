import { it } from "node:test";
import assert from "node:assert/strict";
import { initTheme, CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent";
import { Subagent } from "../pi-extension/subagents/runtime.ts";
import { NativeTranscript } from "../pi-extension/subagents/native-transcript.ts";
import { prepareNativeRenderers } from "../pi-extension/subagents/native-context.ts";
initTheme("dark", false);
await prepareNativeRenderers();
const tui: any = { requestRender() {} };

it("opens and expands a transcript after live compaction with the native token count", () => {
  const agent = new Subagent("native-floor-tests", "scout", "task", "session", false);
  agent.receive({ type: "compaction_end", result: { summary: "Compacted work", tokensBefore: 12345 } });
  const transcript = new NativeTranscript(agent, tui);
  assert.match(transcript.render(100).join("\n"), new RegExp((12345).toLocaleString()));
  assert.ok(transcript.container.children.some((c) => c instanceof CompactionSummaryMessageComponent));
  transcript.toggleTools();
  assert.doesNotThrow(() => transcript.render(100));
  transcript.invalidate();
  assert.doesNotThrow(() => transcript.render(100));
});

it("legacy/malformed compaction entries do not prevent opening or repainting a child view", () => {
  for (const tokensBefore of [undefined, null, "12345", NaN, Infinity, -1]) {
    const agent = new Subagent("native-floor-tests", "scout", "task", "session", false);
    const entry = { role: "compactionSummary", summary: "Preserved summary", tokensBefore };
    agent.loadMessages([entry]);
    let faults = 0;
    agent.on("fault", () => faults++);
    const transcript = new NativeTranscript(agent, tui);
    const lines = transcript.render(100).join("\n");
    assert.match(lines, /Token count unavailable/);
    assert.match(lines, /Preserved summary/);
    transcript.toggleTools();
    transcript.invalidate();
    assert.doesNotThrow(() => transcript.render(100));
    assert.equal(faults, 0);
    assert.equal(agent.messages[0], entry, "presentation recovery must not rewrite saved/model messages");
    assert.equal(agent.error, undefined);
  }
});
