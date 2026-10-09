import { it } from "node:test";
import assert from "node:assert/strict";
import { pinWidgetFirst } from "../pi-extension/subagents/native-context.ts";

it("pins the subagent widget before observation progress without recreating either widget", () => {
  const context: any = { sessionManager: {} };
  const observation = {}, subagents = {}, other = {};
  const widgets = new Map([ ["observations", observation], ["subagent-status", subagents], ["other", other] ]);
  let redraws = 0;
  const frontend = { extensionWidgetsAbove: widgets, renderWidgets: () => redraws++ };
  const bridge = (globalThis as any)[Symbol.for("pi-subagents/native-presentation")];
  bridge.frontends.set(context.sessionManager, frontend);
  pinWidgetFirst(context, "subagent-status");
  assert.deepEqual([...widgets.keys()], ["subagent-status", "observations", "other"]);
  assert.equal(widgets.get("observations"), observation);
  assert.equal(widgets.get("subagent-status"), subagents);
  assert.equal(redraws, 1);
  pinWidgetFirst(context, "subagent-status");
  assert.equal(redraws, 1, "already-correct ordering must not rebuild the widget area");
});
