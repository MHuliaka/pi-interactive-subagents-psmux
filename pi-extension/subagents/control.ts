import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QUESTION_DESCRIPTION, QUESTION_SNIPPET, QUESTION_GUIDELINES, QUESTION_ACK } from "./contract.ts";
import { Type } from "@sinclair/typebox";

/** Child control is protocol-native: no sidecars, polling, or auto-exit hooks. */
export default function (pi: ExtensionAPI) {
  // IPC disappears when the owning parent crashes. This guard also runs in leaf
  // agents, which do not load the delegation extension itself.
  let context: ExtensionContext | undefined;
  const disconnect = () => {
    const deadline = setTimeout(() => process.exit(1), 3000);
    deadline.unref();
    try { context?.abort(); context?.shutdown(); } catch { process.exit(1); }
  };
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (process.env.PI_SUBAGENT_ID) {
      process.off("disconnect", disconnect);
      if (process.connected && typeof process.send === "function") process.once("disconnect", disconnect);
      else disconnect(); // Parent may have died before extensions finished loading.
    }
  });
  pi.on("session_shutdown", () => { process.off("disconnect", disconnect); });
  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description: QUESTION_DESCRIPTION,
    promptSnippet: QUESTION_SNIPPET,
    promptGuidelines: QUESTION_GUIDELINES,
    parameters: Type.Object({ question: Type.String({ description: "The single freeform question to ask the orchestrator. Include enough context to answer it directly." }) }),
    async execute(_id, params) {
      pi.appendEntry("subagent_question", { question: params.question });
      return { content: [{ type: "text", text: QUESTION_ACK }], details: { question: params.question } };
    },
  });
}
