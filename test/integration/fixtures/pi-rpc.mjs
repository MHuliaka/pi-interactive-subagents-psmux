// Deterministic Pi protocol fixture: real pipes/process lifecycle, no provider credentials.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const session = args[args.indexOf("--session") + 1];
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
let question = false;
let running = false;
let buffer = "";
function persist(message) {
  mkdirSync(dirname(session), { recursive: true });
  if (!existsSync(session)) appendFileSync(session, JSON.stringify({ type: "session", id: "fixture", version: 3, cwd: process.cwd() }) + "\n");
  appendFileSync(session, JSON.stringify({ type: "message", id: String(Date.now()), message }) + "\n");
}
function message(value) {
  send({ type: "message_start", message: value });
  send({ type: "message_end", message: value });
  persist(value);
}
function command(request) {
  const reply = (data) => send({ type: "response", id: request.id, command: request.type, success: true, data });
  if (request.type === "get_state") return reply({ isStreaming: running, sessionFile: session });
  if (request.type === "get_messages") {
    const messages = existsSync(session) ? readFileSync(session, "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.type === "message").map((e) => e.message) : [];
    return reply({ messages });
  }
  if (request.type === "clear_queue") return reply({ steering: [], followUp: [] });
  if (request.type === "abort") { running = false; send({ type: "agent_settled", aborted: true }); return reply(); }
  if (request.type === "prompt") {
    reply({ disposition: "started" });
    running = true;
    send({ type: "agent_start" });
    message({ role: "user", content: [{ type: "text", text: request.message }] });
    if (request.message.includes("CRASH")) { process.stderr.write("fixture crash"); process.exit(2); }
    if (request.message.includes("HOLD")) return;
    if (request.message.includes("ASK") && !question) {
      question = true;
      send({ type: "entry_appended", entry: { type: "custom", customType: "subagent_question", data: { question: "Which file?" } } });
      send({ type: "agent_settled", aborted: false });
      running = false;
      return;
    }
    setTimeout(() => {
      if (!running) return;
      const answer = { role: "assistant", content: [{ type: "text", text: `Done: ${request.message}` }], stopReason: "stop", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } } };
      message(answer);
      running = false;
      send({ type: "agent_end", messages: [answer], willRetry: false });
      send({ type: "agent_settled", aborted: false });
    }, 40);
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) command(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
