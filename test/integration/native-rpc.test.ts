import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpc } from "../../pi-extension/subagents/rpc.ts";
import { seedSubagentSessionFile } from "../../pi-extension/subagents/session.ts";

it("loads the extension in the real Pi RPC runtime and shuts down cleanly without a model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-rpc-"));
  const extension = fileURLToPath(new URL("../../pi-extension/subagents/index.ts", import.meta.url));
  const control = fileURLToPath(new URL("../../pi-extension/subagents/control.ts", import.meta.url));
  const dialogTest = fileURLToPath(new URL("./fixtures/rpc-dialog.ts", import.meta.url));
  const session = join(dir, "session.jsonl");
  seedSubagentSessionFile({ mode: "standalone", childSessionFile: session, childCwd: dir });
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PATH: "" };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path" && key !== "PATH") delete (env as any)[key];
  const rpc = new PiRpc(["--offline", "--session", session, "--no-extensions", "--no-mcp", "-e", extension, "-e", control, "-e", dialogTest],
    { cwd: dir, env });
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

it("relays a three-level tree and routes user input through the real Pi RPC extension runtime", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi native tree spaces "));
  const agentDir = join(dir, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "branch.md"), "---\nname: branch\nmodel: inherit\ntools: read\nsubagent_agents: branch, scout\n---\nTest branch\n");
  const wrapper = fileURLToPath(new URL("./fixtures/native-tree.ts", import.meta.url));
  const control = fileURLToPath(new URL("../../pi-extension/subagents/control.ts", import.meta.url));
  const session = join(dir, "session.jsonl");
  seedSubagentSessionFile({ mode: "standalone", childSessionFile: session, childCwd: dir });
  const rpc = new PiRpc(["--offline", "--session", session, "--no-extensions", "--no-mcp", "-e", wrapper, "-e", control],
    { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_ID: "native-root", PI_SUBAGENT_ALLOWED: "branch,scout" } });
  const packets: any[] = [];
  const errors: any[] = [];
  rpc.on("tree", (packet) => packets.push(packet));
  rpc.on("record", (record) => { if (record.type === "extension_error") errors.push(record); });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Native tree timed out: ${rpc.process.pid}; ${JSON.stringify(errors)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await rpc.request("get_state");
    await rpc.prompt("/native-tree-start");
    await wait(() => packets.some((p) => p.kind === "record" && p.route.length === 3 && p.record.type === "agent_start"));
    const leaf = packets.find((p) => p.kind === "spawn" && p.route.length === 3);
    assert.equal(leaf.node.name, "leaf");
    assert.ok(leaf.node.pid > 0);
    await rpc.treeRequest(leaf.route, "prompt", { message: "HOLD native routed message" });
    await wait(() => packets.some((p) => p.kind === "record" && p.route.join("/") === leaf.route.join("/") && p.record.type === "message_end" && p.record.message.role === "user" && p.record.message.content[0].text === "HOLD native routed message"));
    assert.deepEqual(errors, []);
    await rpc.stop();
    assert.equal((await rpc.closed).code, 0);
    assert.ok(packets.some((p) => p.kind === "closed" && p.route.length === 3 && p.result.phase === "cancelled"), "shutdown must flush descendant exit states before Pi exits");
  } finally { await rpc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
