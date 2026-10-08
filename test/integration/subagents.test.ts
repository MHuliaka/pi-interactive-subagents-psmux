import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PiRpc } from "../../pi-extension/subagents/rpc.ts";
const root = mkdtempSync(join(tmpdir(), "pi rpc integration "));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { default: extension } = await import("../../pi-extension/subagents/index.ts");
const fixture = fileURLToPath(new URL("./fixtures/pi-rpc.mjs", import.meta.url));
after(() => {
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(join(root, "parent "));
  const events = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const results: any[] = [];
  const launches: any[] = [];
  const processes: PiRpc[] = [];
  const ui: any = {
    notify() {}, setWidget() {}, onTerminalInput() { return () => {}; },
  };
  const ctx: any = {
    cwd: dir, mode: "rpc", hasUI: true, ui, model: { provider: "test", id: "parent", reasoning: true },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "parent", reasoning: true }] },
    sessionManager: { getSessionDir: () => dir, getSessionId: () => "main", getSessionFile: () => join(dir, "main.jsonl") },
  };
  mkdirSync(dir, { recursive: true });
  const api: any = {
    on: (name: string, handler: any) => events.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
    getThinkingLevel: () => "medium",
    sendMessage: (message: any) => results.push(message),
  };
  extension(api, { createRpc: (args, options) => {
    launches.push({ args, options });
    const rpc = new PiRpc(args, options, (_command, rawArgs, opts) => spawn(process.execPath, [fixture, ...rawArgs.slice(2)], { ...opts, stdio: "pipe" }));
    processes.push(rpc);
    return rpc;
  } });
  await events.get("session_start")({}, ctx);
  const execute = (name: string, params: any) => tools.get(name).execute("test", params, undefined, undefined, ctx);
  return { ctx, execute, commands, events, processes, results, launches, shutdown: () => events.get("session_shutdown")({}, ctx) };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Integration test timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("launches concurrent agents, reports once, persists and resumes the same session", async () => {
  const h = await setup();
  try {
    const [a, b] = await Promise.all([
      h.execute("subagent", { agent: "scout", task: "COMPLETE first" }),
      h.execute("subagent", { agent: "scout", task: "COMPLETE second" }),
    ]);
    assert.equal(a.details.name, "scout");
    assert.equal(b.details.name, "scout-2");
    await waitFor(() => h.results.length === 2);
    assert.ok(h.results.every((r) => r.details.phase === "completed"));
    assert.ok(existsSync(a.details.sessionFile + ".loadout.json"));
    const launch = h.launches[0];
    assert.ok(launch.args.includes("--no-extensions"));
    assert.ok(launch.args.includes("--no-mcp"));
    assert.ok(!launch.args.some((a: string) => a.startsWith("@") || a.includes("__SUBAGENT_DONE")));
    await h.execute("subagent_message", { name: "scout", message: "COMPLETE follow-up" });
    await waitFor(() => h.results.length === 3);
    assert.equal(h.launches[2].args[h.launches[2].args.indexOf("--session") + 1], a.details.sessionFile);
    assert.equal(h.launches[2].args[h.launches[2].args.indexOf("--tools") + 1], "read,grep,find,ls,ask_question");
  } finally { await h.shutdown(); }
});

it("question flow stays alive, reply completes, and crash restores the selected view", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "scout", task: "ASK which file" });
    await waitFor(() => h.results.some((r) => r.customType === "subagent_question"));
    assert.equal(h.results.filter((r) => r.customType === "subagent_result").length, 0);
    await h.execute("subagent_message", { name: "scout", message: "COMPLETE a.ts" });
    await waitFor(() => h.results.some((r) => r.customType === "subagent_result"));
    await h.execute("subagent", { agent: "scout", name: "crasher", task: "HOLD" });
    let component: any;
    let returned = false;
    let consume: any;
    h.ctx.mode = "tui";
    h.ctx.ui.onTerminalInput = (handler: any) => { consume = handler; return () => { consume = undefined; }; };
    h.ctx.ui.custom = (factory: any) => new Promise<void>((resolve) => {
      component = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c: any, text: string) => text }, {}, () => { returned = true; resolve(); });
    });
    const viewing = h.commands.get("subagents").handler("crasher", h.ctx);
    assert.ok(component);
    assert.ok(consume);
    h.processes[1].process.kill();
    await viewing;
    assert.equal(returned, true);
    assert.equal(consume, undefined);
    await waitFor(() => h.results.some((r) => r.details?.name === "crasher"));
    assert.equal(h.results.find((r) => r.details?.name === "crasher").details.phase, "failed");
  } finally { await h.shutdown(); }
});

it("stopping the selected agent returns to main without cancelling another child", async () => {
  const h = await setup();
  try {
    await h.execute("subagent", { agent: "scout", name: "one", task: "HOLD" });
    await h.execute("subagent", { agent: "scout", name: "two", task: "HOLD" });
    let consume: any;
    let returned = 0;
    h.ctx.mode = "tui";
    h.ctx.ui.onTerminalInput = (handler: any) => { consume = handler; return () => { consume = undefined; }; };
    h.ctx.ui.custom = (factory: any) => new Promise<void>((resolve) => {
      factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c: any, text: string) => text }, {}, () => { returned++; resolve(); });
    });
    const viewing = h.commands.get("subagents").handler("one", h.ctx);
    assert.deepEqual(consume("\x03"), { consume: true });
    await viewing;
    assert.equal(returned, 1);
    await waitFor(() => h.results.some((r) => r.details?.name === "one"));
    assert.equal(h.results[0].details.phase, "cancelled");
    const list = await h.execute("subagents_list", {});
    assert.equal(list.details.sessions.find((s: any) => s.name === "two").phase, "running");
    await h.shutdown();
    await Promise.all(h.processes.map((rpc) => rpc.closed));
    assert.equal(h.results.length, 1, "shutdown must not deliver results into a dead parent session");
  } finally { await h.shutdown(); }
});
