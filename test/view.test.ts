import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentScreen, SubagentWidget, blueBox } from "../pi-extension/subagents/view.ts";
import { Subagent } from "../pi-extension/subagents/runtime.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function setup() {
  const agent = new Subagent("仕事 😀", "worker", "A very long task", "session", true);
  let stopped = 0;
  agent.phase = "running";
  (agent as any).stop = async () => { stopped++; agent.emit("settled"); };
  let closed = 0;
  let redraws = 0;
  const tui: any = { terminal: { rows: 24 }, requestRender: () => redraws++ };
  const screen = new SubagentScreen(tui, theme, agent, () => closed++);
  return { agent, screen, tui, closed: () => closed, stopped: () => stopped, redraws: () => redraws };
}

describe("in-tab view", () => {
  it("covers the viewport, keeps the blue Return control, and fits narrow/wide terminals", () => {
    const h = setup();
    for (const width of [0, 1, 3, 10, 40, 80, 120]) {
      const lines = h.screen.render(width);
      assert.equal(lines.length, 24);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
      if (width >= 40) assert.ok(lines.some((line) => line.includes("Return to main agent")));
    }
    h.tui.terminal.rows = 4;
    assert.equal(h.screen.render(40).length, 4);
    h.screen.close();
  });

  it("Escape returns to main without stopping the agent, preserves draft, and disposes listeners", () => {
    const h = setup();
    h.screen.handleInput("draft");
    h.screen.handleInput("\x1b");
    assert.equal(h.closed(), 1);
    assert.equal(h.stopped(), 0);
    assert.equal(h.agent.draft, "draft");
    assert.equal(h.agent.listenerCount("change"), 0);
    assert.equal(h.agent.listenerCount("settled"), 0);
    h.screen.close();
    assert.equal(h.closed(), 1);
  });

  it("Ctrl+C, Ctrl+D and /exit stop only the selected child and restore main exactly once", () => {
    for (const key of ["\x03", "\x04", "/exit\r"]) {
      const h = setup();
      if (key === "/exit\r") { h.screen.handleInput("/exit"); h.screen.handleInput("\r"); }
      else h.screen.handleInput(key);
      assert.equal(h.stopped(), 1);
      assert.equal(h.closed(), 1);
    }
  });

  it("Ctrl+Alt+G returns to main without stopping the selected child", () => {
    const h = setup();
    h.screen.handleInput("\x1b[103;7u");
    assert.equal(h.closed(), 1);
    assert.equal(h.stopped(), 0);
  });

  it("automatic settlement or an unexpected exit restores main", () => {
    const h = setup();
    h.agent.emit("settled");
    assert.equal(h.closed(), 1);
    assert.equal(h.stopped(), 0);
    h.agent.emit("settled");
    assert.equal(h.closed(), 1);
  });

  it("clicking Return restores main without stopping the child", () => {
    const h = setup();
    const lines = h.screen.render(80);
    const row = lines.findIndex((line) => line.includes("Return to main agent"));
    h.screen.handleMouse({ type: "click", button: "left", y: row } as any);
    assert.equal(h.closed(), 1);
    assert.equal(h.stopped(), 0);
  });

  it("bounds the main widget to five rows and opens clicked agents", () => {
    const agents = Array.from({ length: 15 }, (_, i) => new Subagent(`worker-${i}`, "worker", "task", "s", true));
    let clicked: Subagent | undefined;
    const widget = new SubagentWidget(() => agents, (agent) => clicked = agent);
    const lines = widget.render(80);
    assert.equal(lines.length, 8);
    assert.ok(lines.some((line) => line.includes("15 total")));
    widget.handleMouse({ type: "click", button: "left", y: 1 } as any);
    assert.equal(clicked, agents[10]);
  });

  it("renders streaming text, thinking, old tool output and result details safely", () => {
    const h = setup();
    h.agent.loadMessages([{ role: "assistant", content: [
      { type: "thinking", thinking: "Checking 日本語" },
      { type: "text", text: "**Answer** 😀" },
      { type: "toolCall", id: "edit", name: "edit", arguments: { path: "file.ts" } },
    ] }, { role: "toolResult", toolCallId: "edit", isError: false, content: [{ type: "text", text: "Updated" }], details: { diff: "+new line" } }]);
    for (const width of [10, 40, 80]) {
      const lines = h.screen.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    const text = h.screen.render(80).join("\n");
    assert.ok(text.includes("Updated"));
    assert.ok(text.includes("+new line"));
    h.screen.close();
  });

  it("sends multiline pasted input only to the selected child", async () => {
    const h = setup();
    let sent = "";
    Object.defineProperty(h.agent, "live", { get: () => true });
    h.agent.send = async (message) => { sent = message; };
    h.screen.handleInput("\x1b[200~first line\nsecond line\x1b[201~");
    h.screen.handleInput("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent, "first line\nsecond line");
    h.screen.close();
  });

  it("borders use visible columns for Unicode and ANSI", () => {
    for (const width of [0, 1, 2, 5, 20]) for (const line of blueBox("仕事 😀", ["\x1b[31m仕事 😀 long\x1b[0m"], width)) assert.ok(visibleWidth(line) <= width);
  });
});
