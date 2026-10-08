import { it } from "node:test";
import assert from "node:assert/strict";
import { KEYBINDINGS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import extension from "../pi-extension/subagents/index.ts";
import { SUBAGENT_SHORTCUT, SUBAGENT_SHORTCUT_HINT } from "../pi-extension/subagents/shortcuts.ts";

it("the subagent shortcut does not override a built-in Pi action", () => {
  const conflicts = Object.entries(KEYBINDINGS).filter(([_action, definition]) => {
    const keys = Array.isArray(definition.defaultKeys) ? definition.defaultKeys : [definition.defaultKeys];
    return keys.some((key) => key === SUBAGENT_SHORTCUT);
  });
  assert.deepEqual(conflicts, []);
  assert.equal(SUBAGENT_SHORTCUT, "ctrl+alt+g");
  assert.equal(SUBAGENT_SHORTCUT_HINT, "Ctrl+Alt+G");
});

it("registers the same shortcut that the viewer and widget use", () => {
  const shortcuts: string[] = [];
  extension({
    on() {}, registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
    registerShortcut: (key: string) => shortcuts.push(key),
  } as any);
  assert.deepEqual(shortcuts, [SUBAGENT_SHORTCUT]);
});
