import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { JsonlDecoder, PiRpc } from "../pi-extension/subagents/rpc.ts";
import { Subagent } from "../pi-extension/subagents/runtime.ts";
import { resolvePiLaunch } from "../pi-extension/subagents/launcher.ts";

function harness() {
  const commands: any[] = [];
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, next) {
    const request = JSON.parse(chunk.toString());
    commands.push(request);
    queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { disposition: "started" } }) + "\n"));
    next();
  } });
  let killed = 0;
  child.kill = () => { killed++; queueMicrotask(() => child.emit("close", 1)); return true; };
  child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0)));
  let launch: any;
  const rpc = new PiRpc(["--session", "folder with spaces/test.jsonl"], { cwd: "project", env: { CUSTOM: "yes" } }, (command, args, options) => {
    launch = { command, args, options };
    return child;
  });
  const record = (value: any) => child.stdout.write(JSON.stringify(value) + "\n");
  return { rpc, child, commands, record, launch, killed: () => killed };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("RPC transport", () => {
  it("splits only on LF and supports fragmented records, CRLF and Unicode separators", () => {
    const records: any[] = [];
    const decoder = new JsonlDecoder((r) => records.push(r));
    decoder.push('{"type":"message","text":"a\u2028b\u2029c');
    assert.equal(records.length, 0);
    decoder.push('"}\r\n{"type":"next"}\n');
    assert.deepEqual(records, [{ type: "message", text: "a\u2028b\u2029c" }, { type: "next" }]);
  });

  it("launches the declared Pi CLI directly without a shell or PATH shim and preserves raw paths", async () => {
    const h = harness();
    const target = resolvePiLaunch();
    assert.deepEqual(h.launch.args, [...target.prefix, "--mode", "rpc", "--session", "folder with spaces/test.jsonl"]);
    assert.equal(h.launch.command, process.execPath);
    assert.equal(h.launch.options.shell, false);
    assert.deepEqual(h.launch.options.stdio, ["pipe", "pipe", "pipe", "ipc"]);
    await h.rpc.prompt("first\nsecond");
    assert.equal(h.commands[0].message, "first\nsecond");
    assert.equal(h.commands[0].streamingBehavior, "steer");
    await h.rpc.stop(false);
  });

  it("correlates out-of-order responses and surfaces rejection", async () => {
    const h = harness();
    const p = h.rpc.request("bad");
    const id = h.commands[0].id;
    h.record({ type: "response", id, success: false, error: "No model" });
    await assert.rejects(p, /No model/);
    await h.rpc.stop(false);
  });

  it("clears queues before abort and shuts down once", async () => {
    const h = harness();
    const stop = h.rpc.stop();
    assert.equal(h.rpc.stop(), stop);
    await stop;
    assert.deepEqual(h.commands.map((c) => c.type), ["clear_queue", "abort"]);
    assert.equal(h.killed(), 0);
    await assert.rejects(h.rpc.prompt("late"), /closed/);
  });

  it("cancels blocking child dialogs before awaiting abort", async () => {
    const h = harness();
    h.record({ type: "extension_ui_request", id: "dialog-1", method: "confirm" });
    h.record({ type: "extension_ui_request", id: "dialog-2", method: "editor" });
    await h.rpc.stop();
    assert.deepEqual(h.commands.map((c) => c.type), ["extension_ui_response", "extension_ui_response", "clear_queue", "abort"]);
    assert.equal(h.commands[0].cancelled, true);
    assert.equal(h.commands[1].id, "dialog-2");
    assert.equal(h.killed(), 0);
  });

  it("rejects pending commands on startup failure", async () => {
    const h = harness();
    const pending = h.rpc.request("get_state");
    h.child.emit("error", new Error("spawn pi ENOENT"));
    await assert.rejects(pending, /ENOENT/);
    assert.equal((await h.rpc.closed).code, 1);
  });

  it("routes nested controls through IPC and correlates replies", async () => {
    const h = harness();
    h.child.connected = true;
    h.child.send = (packet: any, callback: any) => {
      assert.deepEqual(packet.route, ["parent", "child"]);
      assert.equal(packet.action, "prompt");
      assert.equal(packet.message, "nested\nmessage");
      queueMicrotask(() => h.child.emit("message", { channel: packet.channel, kind: "reply", id: packet.id, success: true, data: "accepted" }));
      callback(null);
      return true;
    };
    assert.equal(await h.rpc.treeRequest(["parent", "child"], "prompt", { message: "nested\nmessage" }), "accepted");
    await h.rpc.stop(false);
    await assert.rejects(h.rpc.treeRequest(["child"], "stop"), /closed/);
  });

  it("rejects IPC requests when the owner crashes", async () => {
    const h = harness();
    h.child.connected = true;
    h.child.send = (_packet: any, callback: any) => { callback(null); return true; };
    const pending = h.rpc.treeRequest(["child"], "stop");
    h.child.emit("close", 2);
    await assert.rejects(pending, /exited/);
  });

  it("bounds unresponsive shutdown with a kill fallback", async () => {
    const h = harness();
    h.child.stdin.removeAllListeners("finish");
    await h.rpc.stop(false);
    assert.equal(h.killed(), 1);
  });
});

describe("subagent lifecycle", () => {
  it("does not treat agent_end as completion, but exits after agent_settled", async () => {
    const h = harness();
    const agent = new Subagent("worker", "worker", "task", "session", true, h.rpc);
    let finished = 0;
    agent.on("finished", () => finished++);
    h.record({ type: "agent_start" });
    h.record({ type: "agent_end", willRetry: true });
    assert.equal(agent.live, true);
    h.record({ type: "auto_retry_start", attempt: 1 });
    h.record({ type: "agent_settled", aborted: false });
    await h.rpc.closed;
    await tick();
    assert.equal(agent.phase, "completed");
    assert.equal(finished, 1);
    assert.deepEqual(h.commands, []);
  });

  it("reconstructs deltas and replaces them with authoritative content", async () => {
    const h = harness();
    const agent = new Subagent("worker", "worker", "task", "session", true, h.rpc);
    h.record({ type: "message_start", message: { role: "assistant", content: [] } });
    h.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" } });
    h.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });
    assert.equal(agent.summary, "hello");
    h.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello!" }] } });
    assert.equal(agent.summary, "Hello!");
    h.record({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "a" } });
    h.record({ type: "tool_execution_update", toolCallId: "read", partialResult: { content: [{ type: "text", text: "partial" }] } });
    h.record({ type: "tool_execution_end", toolCallId: "read", result: { content: [{ type: "text", text: "full" }] }, isError: true });
    assert.equal(agent.tools.get("read")?.state, "failed");
    assert.equal(agent.tools.get("read")?.result.content[0].text, "full");
    await agent.stop();
  });

  it("keeps a questioning agent alive until the parent answers", async () => {
    const h = harness();
    const agent = new Subagent("worker", "worker", "task", "session", true, h.rpc);
    let question: string | undefined;
    agent.on("question", (q) => question = q);
    h.record({ type: "entry_appended", entry: { customType: "subagent_question", data: { question: "Which file?" } } });
    h.record({ type: "agent_settled", aborted: false });
    assert.equal(question, "Which file?");
    assert.equal(agent.phase, "waiting");
    assert.equal(agent.live, true);
    await agent.send("a.ts");
    h.record({ type: "agent_settled", aborted: false });
    await h.rpc.closed;
    assert.equal(agent.phase, "completed");
  });

  it("waits for nested children and then completes", async () => {
    const h = harness();
    const agent = new Subagent("worker", "worker", "task", "session", true, h.rpc);
    h.record({ type: "entry_appended", entry: { customType: "subagent_children", data: { count: 1 } } });
    h.record({ type: "agent_settled", aborted: false });
    assert.equal(agent.phase, "waiting");
    h.record({ type: "entry_appended", entry: { customType: "subagent_children", data: { count: 0 } } });
    h.record({ type: "agent_settled", aborted: false });
    await h.rpc.closed;
    assert.equal(agent.phase, "completed");
  });

  it("reports crash/provider failure and cancellation distinctly", async () => {
    const h = harness();
    const agent = new Subagent("worker", "worker", "task", "session", true, h.rpc);
    h.child.stderr.write("provider broke");
    h.child.emit("close", 2);
    await tick();
    assert.equal(agent.phase, "failed");
    assert.match(agent.error!, /provider broke/);
    const h2 = harness();
    const agent2 = new Subagent("worker", "worker", "task", "session", true, h2.rpc);
    await agent2.stop();
    assert.equal(agent2.phase, "cancelled");
  });

  it("hydrates resumed history including old tool results", () => {
    const agent = new Subagent("worker", "worker", "task", "session", true);
    agent.loadMessages([
      { role: "assistant", provider: "test", model: "model", content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolCallId: "read", isError: false, content: [{ type: "text", text: "old file content" }] },
      { role: "assistant", content: [{ type: "text", text: "Old answer" }] },
    ]);
    assert.equal(agent.messages.length, 2);
    assert.equal(agent.tools.get("read")?.result.content[0].text, "old file content");
    assert.equal(agent.model, "test/model");
  });

  it("marks a nonzero exit during completion as failed, not completed", async () => {
    const h = harness();
    const agent = new Subagent("worker", "worker", "task", "session", true, h.rpc);
    h.record({ type: "agent_settled", aborted: false });
    h.child.emit("close", 2);
    await tick();
    assert.equal(agent.phase, "failed");
    assert.match(agent.error!, /code 2/);
  });

  it("keeps auto-exit:false sessions available for another prompt", async () => {
    const h = harness();
    const agent = new Subagent("planner", "planner", "task", "session", false, h.rpc);
    h.record({ type: "agent_settled", aborted: false });
    assert.equal(agent.phase, "waiting");
    await agent.send("next task");
    assert.equal(h.commands[0].message, "next task");
    await agent.stop();
  });
});
