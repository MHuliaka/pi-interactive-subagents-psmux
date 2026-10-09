import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentScreen, SubagentWidget, blueBox, orderAgents, guardComponent, formatAgentRows } from "../pi-extension/subagents/view.ts";
import { Subagent } from "../pi-extension/subagents/runtime.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, CustomEditor } from "@earendil-works/pi-coding-agent";
import { nativePresentation } from "../pi-extension/subagents/native-context.ts";
initTheme("dark", false);
const { prepareNativeRenderers } = await import("../pi-extension/subagents/native-context.ts");
await prepareNativeRenderers();

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function setup(live = false) {
  const agent = new Subagent("仕事 😀", "worker", "A very long task", "session", true);
  let stopped = 0;
  agent.phase = "running";
  agent.activity = "working";
  if (live) Object.defineProperty(agent, "live", { get: () => !["completed", "cancelled", "failed"].includes(agent.phase) });
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

  it("aligns profile/status/activity/time columns while preserving hierarchy prefixes", () => {
    const agents = [new Subagent("short", "worker", "task", "s", true), new Subagent("parent/仕事 😀", "scout", "task", "s", true)];
    agents[1].depth = 1;
    agents[0].phase = "running"; agents[1].phase = "waiting";
    agents[0].activity = "thinking"; agents[1].activity = "working";
    const rows = formatAgentRows(agents, 100);
    assert.ok(rows[0].startsWith(" › short"));
    assert.ok(rows[1].startsWith("   ↳ parent/仕事 😀"));
    const positions = rows.map((row) => [
      visibleWidth(row.slice(0, row.indexOf("("))),
      ...[...row.matchAll(/ · /g)].map((match) => visibleWidth(row.slice(0, match.index))),
    ]);
    assert.deepEqual(positions[0], positions[1]);
    assert.equal((rows[0].match(/ · /g) ?? []).length, 3, "no new separators");
  });

  it("truncates long names with three dots without pushing other columns", () => {
    const agents = [new Subagent("an-extremely-long-agent-name-".repeat(4), "worker", "task", "s", true), new Subagent("short", "scout", "task", "s", true)];
    for (const agent of agents) { agent.phase = "running"; agent.activity = "thinking"; }
    const rows = formatAgentRows(agents, 60);
    assert.ok(rows[0].includes("..."));
    assert.ok(rows[0].includes("(worker)"));
    assert.ok(rows[0].includes("running"));
    assert.ok(rows[0].includes("thinking"));
    assert.equal(visibleWidth(rows[0].slice(0, rows[0].indexOf("("))), visibleWidth(rows[1].slice(0, rows[1].indexOf("("))));
    for (const width of [0, 1, 3, 10, 30, 60]) for (const row of formatAgentRows(agents, width)) assert.ok(visibleWidth(row) <= width);
  });

  it("bounds the main widget to five rows and opens clicked agents", () => {
    const agents = Array.from({ length: 15 }, (_, i) => new Subagent(`worker-${i}`, "worker", "task", "s", true));
    for (const agent of agents) Object.defineProperty(agent, "live", { get: () => !["completed", "cancelled", "failed"].includes(agent.phase) });
    let clicked: Subagent | undefined;
    const widget = new SubagentWidget(() => agents, (agent) => clicked = agent);
    const lines = widget.render(80);
    assert.equal(lines.length, 8);
    assert.ok(lines.some((line) => line.includes("15 active")));
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
    assert.ok(text.includes("edit"));
    assert.ok(text.includes("+new line"));
    assert.ok(!text.includes('"diff"'), "native tools must not dump result details as JSON");
    h.screen.close();
  });

  it("uses the active extension's custom editor factory without replacing the main editor", () => {
    const agent = new Subagent("styled", "worker", "task", "saved", true);
    agent.draft = "child draft";
    let factories = 0;
    const presentation = { ...nativePresentation(), editorFactory: () => (tui: any, editorTheme: any, keys: any) => {
      factories++;
      const editor = new CustomEditor(tui, editorTheme, keys);
      const render = editor.render.bind(editor);
      editor.render = (width) => ["EXTENSION EDITOR", ...render(width)];
      return editor;
    } };
    const screen = new SubagentScreen({ terminal: { rows: 24 }, requestRender() {} } as any, theme, agent, () => {}, presentation);
    assert.ok(screen.render(100).join("\n").includes("EXTENSION EDITOR"));
    assert.equal(factories, 1);
    screen.close();
    assert.equal(agent.draft, "child draft");
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

  it("animates a native loader even when no RPC events arrive, and disposes its timer", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = setup(true);
    t.after(() => h.screen.close());
    const first = h.screen.render(80).join("\n");
    assert.ok(first.includes("Working…"));
    const redraws = h.redraws();
    t.mock.timers.tick(80);
    assert.ok(h.redraws() > redraws);
    assert.notEqual(h.screen.render(80).join("\n"), first);
    h.agent.activity = "thinking";
    h.agent.changed();
    assert.ok(h.screen.render(80).some((line) => line.includes("Thinking…")));
    h.screen.close();
    const stopped = h.redraws();
    t.mock.timers.tick(800);
    assert.equal(h.redraws(), stopped);
  });

  it("animates child waiting, but stops loading while waiting for an answer or idle message", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = setup(true);
    t.after(() => h.screen.close());
    h.agent.phase = "waiting";
    h.agent.activity = "awaiting children";
    h.agent.changed();
    assert.ok(h.screen.render(80).some((line) => line.includes("Waiting for child agents…")));
    for (const activity of ["awaiting answer", "ready for a message"]) {
      h.agent.activity = activity;
      h.agent.changed();
      const before = h.redraws();
      t.mock.timers.tick(800);
      assert.equal(h.redraws(), before);
      assert.ok(!h.screen.render(80).some((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)));
    }
    h.agent.phase = "running";
    h.agent.activity = "working";
    h.agent.changed();
    assert.ok(h.screen.render(80).some((line) => line.includes("Working…")));
  });

  it("cleans completed, cancelled, failed and saved agents out of the active widget", () => {
    const agents = ["active", "completed", "cancelled", "failed", "saved"].map((name) => new Subagent(name, "worker", "task", "s", true));
    Object.defineProperty(agents[0], "live", { get: () => agents[0].phase === "running" });
    agents[0].phase = "running";
    agents[1].phase = "completed";
    agents[2].phase = "cancelled";
    agents[3].phase = "failed";
    agents[4].phase = "completed";
    const widget = new SubagentWidget(() => agents, () => {});
    const text = widget.render(100).join("\n");
    assert.ok(text.includes("active (worker)"));
    assert.ok(!/(completed|cancelled|failed|saved) \(worker\)/.test(text));
    agents[0].phase = "completed";
    assert.deepEqual(widget.render(100), []);
    assert.equal(agents.length, 5, "widget cleanup must not delete saved conversations");
  });

  it("groups descendants below their parent despite concurrent arrival order", () => {
    const one = new Subagent("one", "worker", "task", "s", true);
    const two = new Subagent("two", "worker", "task", "s", true);
    const child = new Subagent("one/leaf", "scout", "task", "s", true);
    child.parentId = one.id;
    assert.deepEqual(orderAgents([one, two, child]).map((a) => a.name), ["one", "one/leaf", "two"]);
    one.parentId = child.id; // Corrupted topology must not loop forever.
    assert.equal(orderAgents([one, two, child]).length, 3);
  });

  it("guards dialog and selector callback failures without throwing into Pi's TUI", () => {
    const errors: unknown[] = [];
    const component = guardComponent({ render() { throw new Error("bad render"); }, invalidate() { throw new Error("bad invalidate"); }, handleInput() { throw new Error("bad input"); } }, (error) => errors.push(error));
    assert.deepEqual(component.render(), []);
    component.invalidate();
    component.handleInput();
    assert.equal(errors.length, 3);
  });

  it("borders use visible columns for Unicode and ANSI", () => {
    for (const width of [0, 1, 2, 5, 20]) for (const line of blueBox("仕事 😀", ["\x1b[31m仕事 😀 long\x1b[0m"], width)) assert.ok(visibleWidth(line) <= width);
  });
});
