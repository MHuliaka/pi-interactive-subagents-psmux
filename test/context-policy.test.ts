import { it } from "node:test";
import assert from "node:assert/strict";
import { buildSessionProjection, convertToLlm } from "@earendil-works/pi-coding-agent";
import { filterContext, filterSummaryEntries } from "../pi-extension/subagents/context-policy.ts";

it("allows only intended owned-agent notifications without stripping unrelated extension messages", () => {
  const messages: any[] = [
    { role: "custom", customType: "subagent_result", content: "Owned result", details: { name: "worker", delivery: "owner" } },
    { role: "custom", customType: "subagent_question", content: "Owned question", details: { name: "worker" } },
    { role: "custom", customType: "subagent_error", content: "Terminal failure", details: { phase: "failed", name: "worker" } },
    { role: "custom", customType: "other-extension", content: "Keep unrelated extension" },
    { role: "custom", customType: "subagent_error", content: "Legacy tool/UI diagnostic" },
    { role: "custom", customType: "subagent_result", content: "Duplicate descendant result", details: { parent: "worker", name: "worker/leaf" } },
    { role: "custom", customType: "subagent_question", content: 'Subagent "worker/leaf" asks:\n\nLegacy nested question' },
    { role: "custom", customType: "subagent_error", content: "Descendant failure", details: { delivery: "observer", phase: "failed" } },
  ];
  assert.deepEqual(filterContext(messages), messages.slice(0, 4));
  assert.deepEqual(convertToLlm(filterContext(messages)).map((m: any) => m.content[0].text), ["Owned result", "Owned question", "Terminal failure", "Keep unrelated extension"]);
});

it("non-context UI entries never enter Pi's session projection or provider conversion", () => {
  const entries: any[] = [
    { type: "message", id: "user", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Real task", timestamp: Date.now() } },
    { type: "custom", id: "ui", parentId: "user", timestamp: new Date().toISOString(), customType: "subagent_ui", data: { customType: "subagent_error", content: "UI ONLY SECRET" } },
    { type: "custom", id: "status", parentId: "ui", timestamp: new Date().toISOString(), customType: "subagent_children", data: { count: 3 } },
  ];
  const projection = buildSessionProjection(entries);
  const payload = JSON.stringify(convertToLlm(projection.messages));
  assert.ok(payload.includes("Real task"));
  assert.ok(!payload.includes("UI ONLY SECRET"));
  assert.ok(!payload.includes("subagent_children"));
});

it("filters legacy diagnostics and observer notifications before branch summarization", () => {
  const entries: any[] = [
    { type: "custom_message", id: "owned", customType: "subagent_result", content: "Owned result" },
    { type: "custom_message", id: "tool-error", customType: "subagent_error", content: "Internal error" },
    { type: "custom_message", id: "observer", customType: "subagent_result", content: "Nested duplicate", details: { parent: "worker" } },
    { type: "message", id: "user", message: { role: "user", content: "Task" } },
  ];
  const original = entries;
  filterSummaryEntries(entries);
  assert.equal(entries, original);
  assert.deepEqual(entries.map((e) => e.id), ["owned", "user"]);
});
