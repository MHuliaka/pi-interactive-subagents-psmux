import { it } from "node:test";
import assert from "node:assert/strict";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { SubagentResultCard, registerResultRenderer } from "../pi-extension/subagents/result.ts";
initTheme("dark", false);
const content = 'Subagent "scout" completed (12s).\n\nDetailed result\n\nFollow up with subagent_message.';
const click: any = { type: "click", button: "left", x: 2, y: 1 };

it("shows a compact blue result by default, including when main tools start expanded", () => {
  const card = new SubagentResultCard(content);
  card.syncExpanded(true);
  const lines = card.render(80);
  assert.equal(lines.length, 3);
  assert.ok(lines.join("\n").includes("38;2;77;163;255"));
  assert.ok(!lines.join("\n").includes("Detailed result"));
  card.syncExpanded(false);
  card.syncExpanded(true);
  assert.ok(card.render(80).join("\n").includes("Detailed result"));
});

it("clicks expand and collapse the entire result, not a truncated preview", () => {
  const card = new SubagentResultCard(content);
  card.render(80);
  assert.deepEqual(card.handleMouse(click), { handled: true, render: true });
  assert.ok(card.render(80).join("\n").includes("Follow up with"));
  card.syncExpanded(false);
  card.invalidate();
  assert.ok(card.render(80).join("\n").includes("Detailed result"), "ordinary invalidation must preserve click expansion");
  card.handleMouse(click);
  assert.equal(card.render(80).length, 3);
});

it("registers only result cards and preserves their state through native message rebuilds", () => {
  let renderer: any;
  registerResultRenderer({ registerMessageRenderer: (kind: string, callback: any) => {
    assert.equal(kind, "subagent_result"); renderer = callback;
  } } as any);
  const message: any = { role: "custom", customType: "subagent_result", content, display: true };
  const native = new CustomMessageComponent(message, renderer);
  const card = native.children[1] as SubagentResultCard;
  assert.equal(native.render(80).length, 4);
  const mouse = native.handleMouse({ ...click, y: 2, width: 80, height: 4, originX: 0, originY: 0 });
  assert.equal(mouse?.handled, true);
  assert.equal(mouse?.render, true);
  native.invalidate();
  assert.equal(native.children[1], card);
  assert.ok(native.render(80).join("\n").includes("Detailed result"));
  native.setExpanded(true);
  native.setExpanded(false);
  assert.equal(native.render(80).length, 4);
});
