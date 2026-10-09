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
  assert.ok(lines.join("\n").includes("48;2;31;59;73"));
  assert.ok(!lines.join("\n").includes("╭"));
  assert.ok(!lines.join("\n").includes("Detailed result"));
  card.syncExpanded(false);
  card.syncExpanded(true);
  assert.ok(card.render(80).join("\n").includes("Detailed result"));
});

it("shows gray question cards collapsed by default and expands the full question on click", () => {
  const card = new SubagentResultCard('Subagent "scout" asks:\n\nWhich implementation should I use?\n\nReply with subagent_message.', false, "question");
  const compact = card.render(80);
  assert.equal(compact.length, 2);
  assert.ok(compact.join("\n").includes("48;2;48;48;48"));
  assert.ok(compact.join("\n").includes("asks"));
  assert.ok(!compact.join("\n").includes("Reply with"));
  card.handleMouse(click);
  assert.ok(card.render(80).join("\n").includes("Reply with"));
  card.handleMouse(click);
  assert.equal(card.render(80).length, 2);
});

it("shows terminal failures as plain red Error text without a border or background", () => {
  const card = new SubagentResultCard('Subagent "scout" failed (12s).\n\nProvider unavailable', false, "error");
  const lines = card.render(80);
  assert.ok(lines[0].includes("Error:"));
  assert.ok(lines.join("\n").includes("Provider unavailable"));
  assert.ok(lines.join("\n").includes("\x1b[31m"));
  assert.ok(!lines.join("\n").includes("╭"));
  assert.ok(!lines.join("\n").includes("48;"));
  card.handleMouse(click);
  assert.equal(card.render(80).length, 1);
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

it("registers result/error cards and preserves their state through native message rebuilds", () => {
  let renderer: any;
  registerResultRenderer({ registerMessageRenderer: (kind: string, callback: any) => {
    assert.ok(["subagent_result", "subagent_error", "subagent_question"].includes(kind)); renderer = callback;
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
