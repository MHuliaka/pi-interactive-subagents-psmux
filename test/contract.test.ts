import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import extension from "../pi-extension/subagents/index.ts";
import control from "../pi-extension/subagents/control.ts";
import * as contract from "../pi-extension/subagents/contract.ts";
const baseline = JSON.parse(readFileSync(new URL("./fixtures/psmux-contract.json", import.meta.url), "utf8"));

it("matches tool descriptions/snippets/guidelines extracted from the Psmux baseline", () => {
  const tools = new Map<string, any>();
  const api: any = { on() {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {} };
  extension(api); control(api);
  assert.equal(tools.get("subagent").description, baseline.spawnDescription);
  assert.equal(tools.get("subagent").promptSnippet, baseline.spawnSnippet);
  assert.equal(tools.get("subagents_list").description, baseline.listDescription);
  assert.equal(tools.get("subagents_list").promptSnippet, baseline.listDescription);
  assert.equal(tools.get("subagent_message").description, baseline.messageDescription);
  assert.equal(tools.get("subagent_message").promptSnippet, baseline.messageSnippet);
  assert.equal(tools.get("ask_question").description, baseline.questionDescription);
  assert.equal(tools.get("ask_question").promptSnippet, baseline.questionSnippet);
  assert.deepEqual(tools.get("ask_question").promptGuidelines, baseline.questionGuidelines);
  assert.deepEqual(JSON.parse(JSON.stringify(tools.get("subagent").parameters)), baseline.spawnParameters);
  assert.deepEqual(Object.keys(tools.get("subagent").parameters.properties), ["agent", "task", "name", "model", "cwd"]);
  assert.deepEqual(tools.get("subagent").parameters.required, ["agent", "task"]);
  assert.deepEqual(tools.get("subagent_message").parameters.required, ["name", "message"]);
});

it("preserves acknowledgements and the warning not to fabricate results", () => {
  assert.equal(contract.spawnAcknowledgement("scout"), 'Sub-agent "scout" launched and is now running in the background. Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. The results will be delivered to you automatically as a steer message when the sub-agent finishes. Until then, move on to other work or tell the user you\'re waiting.');
  assert.equal(contract.steerAcknowledgement("scout"), 'Message delivered to running subagent "scout". It picks this up at its next turn boundary. If it exits, its result still arrives as a steer message.');
  assert.equal(contract.resumeAcknowledgement("scout"), 'Session "scout" resumed.');
  assert.equal(contract.QUESTION_ACK, "Question sent to the orchestrator. Stop here and wait — do not continue working or assume an answer. Their reply will arrive as your next message.");
});

it("preserves result and question text, including elapsed format and follow-up instructions", () => {
  assert.equal(contract.resultPresentation({ exitCode: 0, elapsed: 61, summary: "Done" }, "scout"), 'Sub-agent "scout" completed (1m 1s).\n\nDone\n\nFollow up with subagent_message({ name: "scout", message: "…" })');
  assert.equal(contract.resultPresentation({ exitCode: 2, elapsed: 61, summary: "Partial" }, "scout"), 'Sub-agent "scout" failed (exit code 2).\n\nPartial\n\nFollow up with subagent_message({ name: "scout", message: "…" })');
  assert.equal(contract.resultPresentation({ exitCode: 1, elapsed: 61, summary: "", errorMessage: "Unavailable" }, "scout"), 'Sub-agent "scout" failed after 1m 1s (provider/agent error — auto-retry exhausted).\n\nError: Unavailable\n\nThe subagent did not produce a result. You can retry by spawning a new subagent or resume the session with subagent_message.\n\nFollow up with subagent_message({ name: "scout", message: "…" })');
  assert.equal(contract.questionPresentation("scout", 61, "Which file?"), 'Sub-agent "scout" asks (1m 1s):\n\nWhich file?\n\nReply with subagent_message({ name: "scout", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.');
});

it("preserves standalone/lineage/fork child instructions without new wrapper prose", () => {
  assert.equal(contract.taskPresentation("Do work", "Role", undefined, true, "standalone"), "\n\nRole\n\nComplete your task autonomously. When you are finished, simply stop — your session ends automatically.\n\nDo work\n\nYour FINAL assistant message should summarize what you accomplished.");
  assert.equal(contract.taskPresentation("Do work", "Role", "append", undefined, "lineage-only"), "\n\nComplete your task. The user can interact with you at any time, and the session ends when the user exits the pane.\n\nDo work\n\nYour FINAL assistant message (before the user exits) should summarize what you accomplished.");
  assert.equal(contract.taskPresentation("Do work", "Role", undefined, true, "fork"), "Do work");
});
