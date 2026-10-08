import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Exercise a real blocking RPC dialog without invoking a model/provider.
export default function (pi: ExtensionAPI) {
  pi.registerCommand("rpc-dialog-smoke", {
    description: "Integration-test blocking confirmation",
    handler: async (_args, ctx) => { await ctx.ui.confirm("Smoke test", "Allow?"); },
  });
}
