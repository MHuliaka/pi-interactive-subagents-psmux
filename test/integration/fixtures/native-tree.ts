import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import extension from "../../../pi-extension/subagents/index.ts";
import { PiRpc } from "../../../pi-extension/subagents/rpc.ts";

/** Real Pi extension loader/commands/IPC, with only model execution replaced. */
export default function (pi: ExtensionAPI) {
  const tools = new Map<string, any>();
  const api = new Proxy(pi, { get(target, property) {
    if (property === "registerTool") return (tool: any) => { tools.set(tool.name, tool); target.registerTool(tool); };
    return Reflect.get(target, property);
  } });
  const fixture = fileURLToPath(new URL("./pi-rpc.mjs", import.meta.url));
  extension(api, { createRpc: (args, options) => new PiRpc(args, options,
    (_command, launchArgs, opts) => spawn(process.execPath, ["--experimental-transform-types", fixture, ...launchArgs.slice(3)], opts) as any) });
  pi.registerCommand("native-tree-start", {
    description: "Start a model-free three-level test tree",
    handler: async (_args, context) => {
      const fixtureContext = { ...context, model: { provider: "test", id: "parent", reasoning: true },
        modelRegistry: { getAvailable: () => [{ provider: "test", id: "parent", reasoning: true }] } };
      await tools.get("subagent").execute("native-tree", { agent: "branch", name: "one", task: "NEST3" }, undefined, undefined, fixtureContext);
    },
  });
}
