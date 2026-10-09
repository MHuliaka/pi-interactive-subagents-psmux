import { it } from "node:test";
import assert from "node:assert/strict";
import { initTheme, UserMessageComponent, AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Subagent } from "../pi-extension/subagents/runtime.ts";
import { NativeTranscript } from "../pi-extension/subagents/native-transcript.ts";
import { nativePresentation, prepareNativeRenderers } from "../pi-extension/subagents/native-context.ts";
initTheme("dark", false);
await prepareNativeRenderers();
const tui: any = { requestRender() {} };

it("renders the same user/assistant/thinking/tool components as Pi, with no JSON detail dump", () => {
  const user: any = { role: "user", content: [{ type: "text", text: "A user message" }] };
  const assistant: any = { role: "assistant", content: [{ type: "thinking", thinking: "A thought" }, { type: "text", text: "An answer" }, { type: "toolCall", id: "read", name: "read", arguments: { path: "file.ts" } }] };
  const result: any = { role: "toolResult", toolCallId: "read", content: [{ type: "text", text: "const answer = 42;" }], details: { unusedPrivateDetails: "do not dump this" }, isError: false };
  const agent = new Subagent("one", "scout", "task", "session", true);
  agent.loadMessages([user, assistant, result]);
  const presentation = nativePresentation();
  const transcript = new NativeTranscript(agent, tui, presentation);
  const tool = new ToolExecutionComponent("read", "read", assistant.content[2].arguments, {}, presentation.tool("read"), tui, process.cwd());
  tool.setArgsComplete(); tool.markExecutionStarted(); tool.updateResult(result);
  const expected = [...new UserMessageComponent("A user message").render(100), ...new AssistantMessageComponent(assistant).render(100), ...tool.render(100)];
  assert.deepEqual(transcript.render(100), expected);
  assert.ok(!expected.join("\n").includes("unusedPrivateDetails"));
  assert.ok(transcript.container.children[0] instanceof UserMessageComponent);
  assert.ok(transcript.container.children[1] instanceof AssistantMessageComponent);
  assert.ok(transcript.container.children[2] instanceof ToolExecutionComponent);
});

it("uses native collapsed read summaries and expanded tool output", () => {
  const agent = new Subagent("one", "scout", "task", "session", true);
  agent.loadMessages([{ role: "assistant", content: [{ type: "toolCall", id: "tool", name: "read", arguments: { path: "file.txt" } }] },
    { role: "toolResult", toolCallId: "tool", content: [{ type: "text", text: Array.from({ length: 25 }, (_, i) => `tool-line-${i}`).join("\n") }] }]);
  const transcript = new NativeTranscript(agent, tui);
  const compact = transcript.render(100).join("\n");
  assert.ok(compact.includes("read"));
  assert.ok(!compact.includes("tool-line-24"));
  transcript.toggleTools();
  assert.ok(transcript.render(100).join("\n").includes("tool-line-24"));
});
