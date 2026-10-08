import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpc } from "../../pi-extension/subagents/rpc.ts";
import { seedSubagentSessionFile } from "../../pi-extension/subagents/session.ts";

it("loads the extension in the real Pi RPC runtime and shuts down cleanly without a model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-rpc-"));
  const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
  const extension = fileURLToPath(new URL("../../pi-extension/subagents/index.ts", import.meta.url));
  const control = fileURLToPath(new URL("../../pi-extension/subagents/control.ts", import.meta.url));
  const dialogTest = fileURLToPath(new URL("./fixtures/rpc-dialog.ts", import.meta.url));
  const session = join(dir, "session.jsonl");
  seedSubagentSessionFile({ mode: "standalone", childSessionFile: session, childCwd: dir });
  const rpc = new PiRpc(["--offline", "--session", session, "--no-extensions", "--no-mcp", "-e", extension, "-e", control, "-e", dialogTest],
    { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") } },
    (_command, args, options) => spawn(process.execPath, [cli, ...args], { ...options, stdio: "pipe" }));
  const errors: any[] = [];
  rpc.on("record", (record) => { if (record.type === "extension_error") errors.push(record); });
  try {
    const state = await rpc.request("get_state");
    assert.equal(state.isStreaming, false);
    assert.equal(state.sessionFile, session);
    const { commands } = await rpc.request("get_commands");
    assert.ok(commands.some((c: any) => c.name === "subagents"), "extension must load successfully through Pi's loader");
    assert.ok(commands.some((c: any) => c.name === "subagent-model"));
    assert.deepEqual(errors, []);
    const dialog = new Promise<void>((resolve) => {
      const onRecord = (record: any) => {
        if (record.type === "extension_ui_request" && record.method === "confirm") { rpc.off("record", onRecord); resolve(); }
      };
      rpc.on("record", onRecord);
    });
    const blockedPrompt = rpc.prompt("/rpc-dialog-smoke");
    // Install a rejection handler immediately in case the process fails to start the dialog.
    const accepted = blockedPrompt.catch(() => undefined);
    await Promise.race([dialog, accepted.then(() => { throw new Error("Dialog command ended before emitting its request"); })]);
    await rpc.stop();
    await accepted;
    assert.equal((await rpc.closed).code, 0);
  } finally {
    await rpc.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
