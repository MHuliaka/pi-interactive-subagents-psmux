import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/** Child control is protocol-native: no sidecars, polling, or auto-exit hooks. */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_question",
    label: "Ask Parent",
    description: "Ask the parent agent a question when you need a decision. After calling, stop your turn and wait for its reply.",
    parameters: Type.Object({ question: Type.String() }),
    async execute(_id, params) {
      pi.appendEntry("subagent_question", { question: params.question });
      return { content: [{ type: "text", text: "Question sent to the parent. Stop here and wait for its reply." }], details: { question: params.question } };
    },
  });
}
