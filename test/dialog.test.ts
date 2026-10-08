import { it } from "node:test";
import assert from "node:assert/strict";
import { ChildDialog } from "../pi-extension/subagents/dialog.ts";
import { Subagent } from "../pi-extension/subagents/runtime.ts";

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function setup(record: any) {
  const agent = new Subagent("worker", "worker", "task", "s", true);
  agent.phase = "running";
  Object.defineProperty(agent, "live", { get: () => agent.phase === "running" });
  let input: any;
  const responses: any[] = [];
  const ctx: any = { ui: { onTerminalInput: (handler: any) => { input = handler; return () => { input = undefined; }; } } };
  const dialog = new ChildDialog({ terminal: { rows: 24 }, requestRender() {} } as any, theme, agent, { id: "question", title: "Choose", ...record }, (response) => responses.push(response), ctx);
  return { dialog, agent, responses, input: () => input };
}

it("a child crash cancels its editor dialog and disposes parent input handlers", () => {
  const h = setup({ method: "editor", prefill: "old text" });
  assert.ok(h.dialog.render(80).length > 0);
  h.agent.emit("finished");
  assert.deepEqual(h.responses, [{ type: "extension_ui_response", id: "question", cancelled: true }]);
  assert.equal(h.input(), undefined);
  assert.equal(h.agent.listenerCount("finished"), 0);
  h.dialog.cancel();
  assert.equal(h.responses.length, 1);
});

it("explicit stop cancels child dialogs before process shutdown completes", () => {
  const h = setup({ method: "input" });
  h.agent.phase = "cancelled";
  h.agent.emit("settled");
  assert.equal(h.responses[0].cancelled, true);
});

it("Ctrl+C is consumed by the dialog, not the parent agent", () => {
  const h = setup({ method: "confirm", message: "Allow?" });
  const input = h.input();
  assert.deepEqual(input("\x03"), { consume: true });
  assert.equal(h.responses[0].cancelled, true);
  assert.equal(h.agent.phase, "running");
});

it("returns confirmation and text responses with the original RPC id", () => {
  const h = setup({ method: "confirm", message: "Allow?" });
  h.dialog.handleInput("\x1b[B");
  h.dialog.handleInput("\r");
  assert.equal(h.responses[0].confirmed, false);
  const h2 = setup({ method: "input" });
  h2.dialog.handleInput("answer");
  h2.dialog.handleInput("\r");
  assert.equal(h2.responses[0].value, "answer");
  assert.equal(h2.responses[0].id, "question");
});

it("child dialog timeout restores the parent UI", async () => {
  const h = setup({ method: "select", options: ["a", "b"], timeout: 10 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(h.responses[0].cancelled, true);
  assert.equal(h.input(), undefined);
});
