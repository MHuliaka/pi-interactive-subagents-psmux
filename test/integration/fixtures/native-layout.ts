import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Subagent } from "../../../pi-extension/subagents/runtime.ts";
import { nativePresentation, prepareNativeRenderers } from "../../../pi-extension/subagents/native-context.ts";
import { NativeTranscript } from "../../../pi-extension/subagents/native-transcript.ts";

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((name, next) => name === "read" ? {
    ...next(), renderCall: () => new Text("EXTENSION TOOL CALL", 0, 0), renderResult: () => new Text("EXTENSION TOOL RESULT", 0, 0),
  } : next());
  pi.registerMarkdownTransformer((text, ctx) => `${ctx.messageType.toUpperCase()} LAYOUT: ${text}`);
  pi.registerMessageRenderer("layout-probe", () => new Text("EXTENSION CUSTOM MESSAGE", 0, 0));
  pi.registerEntryRenderer("layout-probe-entry", () => new Text("EXTENSION CUSTOM ENTRY", 0, 0));
  pi.registerCommand("native-layout-probe", { description: "Probe live native renderer registrations", handler: async (_args, context) => {
    initTheme("dark", false);
    await prepareNativeRenderers();
    const agent = new Subagent("layout", "scout", "probe", "saved", true);
    agent.phase = "completed";
    agent.loadMessages([
      { role: "user", content: [{ type: "text", text: "User text" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "Thinking text" }, { type: "text", text: "Assistant text" }, { type: "toolCall", id: "read", name: "read", arguments: { path: "file.ts" } }] },
      { role: "toolResult", toolCallId: "read", content: [{ type: "text", text: "Tool result" }], details: { secretRawDetail: "must not be dumped" } },
      { role: "custom", customType: "layout-probe", display: true, content: "Custom text" },
    ]);
    agent.loadEntries([{ type: "custom", customType: "layout-probe-entry", data: {}, timestamp: new Date().toISOString() }]);
    const transcript = new NativeTranscript(agent, { requestRender() {} } as any, nativePresentation(pi, context), context.cwd);
    pi.appendEntry("native-layout-probe", { lines: transcript.render(100), components: transcript.container.children.map((c) => c.constructor.name) });
  } });
}
