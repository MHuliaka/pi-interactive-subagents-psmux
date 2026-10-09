// Deterministic Pi protocol fixture: real nested processes/IPC, no provider credentials.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import extension from "../../../pi-extension/subagents/index.ts";
import { PiRpc } from "../../../pi-extension/subagents/rpc.ts";
const args = process.argv.slice(2);
const session = args[args.indexOf("--session") + 1];
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
let question = false;
let running = false;
let buffer = "";
let shuttingDown = false;
let heartbeat;
let lastEntry = existsSync(session) ? readFileSync(session, "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.type === "message").at(-1)?.id : undefined;
function persist(message) {
  mkdirSync(dirname(session), { recursive: true });
  if (!existsSync(session)) appendFileSync(session, JSON.stringify({ type: "session", id: "fixture", version: 3, cwd: process.cwd() }) + "\n");
  const id = randomUUID();
  appendFileSync(session, JSON.stringify({ type: "message", id, parentId: lastEntry, message }) + "\n");
  lastEntry = id;
}
function message(value) {
  send({ type: "message_start", message: value });
  send({ type: "message_end", message: value });
  persist(value);
}
function settle() { running = false; send({ type: "agent_settled", aborted: false }); }
function complete(text) {
  const answer = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } } };
  message(answer);
  send({ type: "agent_end", messages: [answer], willRetry: false });
  settle();
}
const events = new Map();
const tools = new Map();
const ctx = {
  cwd: process.cwd(), mode: "rpc", hasUI: true,
  ui: { notify() {}, setWidget() {} },
  model: { provider: "test", id: "parent", reasoning: true },
  modelRegistry: { getAvailable: () => [{ provider: "test", id: "parent", reasoning: true }] },
  sessionManager: { getSessionDir: () => dirname(session), getSessionId: () => "fixture-parent", getSessionFile: () => session },
};
const api = {
  on: (name, handler) => events.set(name, handler),
  registerTool: (tool) => tools.set(tool.name, tool),
  registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
  getActiveTools: () => [...tools.keys()], setActiveTools() {}, getThinkingLevel: () => "medium",
  appendEntry: (customType, data) => send({ type: "entry_appended", entry: { type: "custom", customType, data } }),
  sendMessage: (value) => {
    if (shuttingDown) return;
    message({ role: "custom", customType: value.customType, content: value.content });
    if (value.customType === "subagent_result" || (value.customType === "subagent_error" && value.details?.phase === "failed")) setTimeout(() => {
      if (!shuttingDown) { send({ type: "agent_start" }); complete("Nested result received: " + value.content); }
    }, 20);
  },
};
extension(api, { createRpc: (rawArgs, options) => new PiRpc(rawArgs, options,
  (_command, launchArgs, opts) => spawn(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url), ...launchArgs.slice(3)], opts)) });
await events.get("session_start")({}, ctx);
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  const deadline = setTimeout(() => process.exit(code || 1), 3000);
  await events.get("session_shutdown")({}, ctx);
  clearTimeout(deadline);
  process.exit(code);
}
async function command(request) {
  const reply = (data) => send({ type: "response", id: request.id, command: request.type, success: true, data });
  if (request.type === "get_state") return reply({ isStreaming: running, sessionFile: session });
  if (request.type === "get_messages") {
    const messages = existsSync(session) ? readFileSync(session, "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.type === "message").map((e) => e.message) : [];
    return reply({ messages });
  }
  if (request.type === "extension_ui_response") { complete(request.cancelled ? "Dialog cancelled" : "Dialog answered"); return; }
  if (request.type === "clear_queue") return reply({ steering: [], followUp: [] });
  if (request.type === "abort") { running = false; send({ type: "agent_settled", aborted: true }); return reply(); }
  if (request.type === "prompt") {
    reply({ disposition: "started" });
    running = true;
    send({ type: "agent_start" });
    message({ role: "user", content: [{ type: "text", text: request.message }] });
    if (request.message.includes("CRASH")) { process.stderr.write("fixture crash"); process.exit(2); }
    if (request.message.includes("NEST3") || request.message.includes("NESTED")) {
      const deep = request.message.includes("NEST3");
      await tools.get("subagent").execute("nested", { agent: deep ? "branch" : "scout", name: deep ? "middle" : "leaf", task: deep ? "NESTED HOLD" : "HOLD" }, undefined, undefined, ctx);
      complete("Waiting for nested children");
      return;
    }
    if (request.message.includes("DIALOG")) {
      send({ type: "extension_ui_request", method: "confirm", id: "leaf-dialog", title: "Continue?", message: "Nested blocking dialog" });
      return;
    }
    if (request.message.includes("TOOL_ERROR")) {
      send({ type: "tool_execution_start", toolCallId: "bad", toolName: "read", args: { path: "missing" } });
      send({ type: "tool_execution_end", toolCallId: "bad", result: { content: [{ type: "text", text: "fixture missing file" }] }, isError: true });
      return;
    }
    if (request.message.includes("HOLD")) {
      if (!heartbeat) heartbeat = setInterval(() => writeFileSync(session + ".heartbeat", String(Date.now())), 50);
      return;
    }
    if (request.message.includes("ASK") && !question) {
      question = true;
      send({ type: "entry_appended", entry: { type: "custom", customType: "subagent_question", data: { question: "Which file?" } } });
      settle();
      return;
    }
    setTimeout(() => { if (running) complete(`Done: ${request.message}`); }, 40);
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) void command(JSON.parse(line)).catch((error) => { process.stderr.write(String(error)); void shutdown(2); });
  }
});
process.stdin.on("end", () => { void shutdown(); });
process.once("disconnect", () => { void shutdown(1); });
