import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// These tests exercise the real command's persistence, but never the user's
// agent directory. Set the directory before config.ts computes its default path.
const root = mkdtempSync(join(tmpdir(), "pi-model-config-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { default: extension, __test__: testApi } = await import("../pi-extension/subagents/index.ts");
const { SUBAGENT_CONFIG_PATH, loadSubagentConfig, parseSubagentConfig, resolveLoadoutModel, writeModelSelection } = await import("../pi-extension/subagents/config.ts");

const parent = { provider: "vendor", id: "parent", reasoning: true };
const cheaper = { provider: "vendor", id: "cheap", reasoning: false };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function setup() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const notices: Array<{ text: string; level: string }> = [];
  const api: any = {
    on() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerMessageRenderer() {},
    registerShortcut() {},
    getThinkingLevel() { return "medium"; },
  };
  extension(api);
  const ctx: any = {
    hasUI: true,
    model: parent,
    modelRegistry: { getAvailable: () => [parent, cheaper], hasConfiguredAuth: () => true },
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
  };
  return { commands, tools, notices, ctx };
}

beforeEach(() => {
  rmSync(SUBAGENT_CONFIG_PATH, { force: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("model configuration integration", () => {
  it("creates the durable directory on the first write and preserves status", () => {
    const configPath = join(root, "new", "nested", "subagents.json");
    const examplePath = join(root, "example.json");
    writeFileSync(examplePath, JSON.stringify({ status: { enabled: false } }));
    const result = writeModelSelection({ agentName: "scout", model: "vendor/cheap", configPath, examplePath, legacyPath: join(root, "absent.json") });
    assert.equal(result.changed, true);
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(saved.status, { enabled: false });
    assert.equal(saved.models.agents.scout.model, "vendor/cheap");
  });

  it("accepts Windows UTF-8 BOM configs", () => {
    const path = join(root, "bom.json");
    writeFileSync(path, '\uFEFF{"models":{"default":"inherit"}}');
    assert.equal(loadSubagentConfig(path).models?.default, "inherit");
  });

  it("rejects prototype-sensitive agent names without writing", () => {
    for (const agentName of ["__proto__", "constructor"]) {
      assert.throws(() => writeModelSelection({ agentName, model: "inherit" }), /unsafe agent name/);
    }
    assert.equal(existsSync(SUBAGENT_CONFIG_PATH), false);
  });

  it("inherits thinking on legacy Pi and prefers newer context fields", () => {
    const { ctx } = setup();
    assert.equal(testApi.buildModelCatalog(ctx).parentThinking, "medium");
    ctx.thinkingLevel = "high";
    assert.equal(testApi.buildModelCatalog(ctx).parentThinking, "high");
  });

  it("uses scoped models when exposed, otherwise the authenticated catalogue", () => {
    const { ctx } = setup();
    assert.deepEqual(testApi.collectPickableModels(ctx), [parent, cheaper]);
    ctx.scopedModels = [{ model: cheaper }];
    assert.deepEqual(testApi.collectPickableModels(ctx), [cheaper]);
  });

  it("uses the custom picker on legacy interactive Pi and requests redraws", async () => {
    const { ctx } = setup();
    let renders = 0;
    ctx.ui.select = () => { throw new Error("should use the custom picker"); };
    ctx.ui.custom = (factory: any) => new Promise(resolve => {
      const component = factory({ requestRender: () => renders++ }, theme, {}, resolve);
      component.handleInput("\x1b[B");
      component.handleInput("\r");
    });
    const choice = await testApi.pickModelChoice(ctx, "model", [
      { value: "a", label: "A", searchText: "A" },
      { value: "b", label: "B", searchText: "B" },
    ]);
    assert.equal(choice, "b");
    assert.equal(renders, 2);
  });

  it("/subagent-model persists a model and thinking through the non-TUI selector", async () => {
    const { commands, notices, ctx } = setup();
    ctx.mode = "rpc";
    const choices = ["scout", "vendor/cheap", "off"];
    ctx.ui.select = async (_title: string, items: string[]) => {
      const choice = choices.shift();
      assert.ok(items.includes(choice!));
      return choice;
    };
    await commands.get("subagent-model").handler("", ctx);
    assert.deepEqual(loadSubagentConfig().models?.agents.scout, { model: "vendor/cheap", thinking: "off" });
    assert.ok(notices.some(notice => notice.text.includes(SUBAGENT_CONFIG_PATH)));
  });

  it("/subagent-model cancels without creating config", async () => {
    const { commands, ctx } = setup();
    ctx.ui.select = async () => undefined;
    await commands.get("subagent-model").handler("", ctx);
    assert.equal(existsSync(SUBAGENT_CONFIG_PATH), false);
  });

  it("/subagent-model resets the agent override and preserves the global default", async () => {
    writeModelSelection({ agentName: null, model: "inherit" });
    writeModelSelection({ agentName: "scout", model: "vendor/cheap", thinking: "off" });
    const { commands, ctx } = setup();
    ctx.mode = "rpc";
    const choices = ["scout", "reset to the agent's own model", "reset to inherited/default"];
    ctx.ui.select = async () => choices.shift();
    await commands.get("subagent-model").handler("", ctx);
    const saved = loadSubagentConfig();
    assert.equal(saved.models?.agents.scout, undefined);
    assert.equal(saved.models?.default, "inherit");
  });

  it("passes the resolved model to the Bash launch command without leaking inherit", () => {
    const loadout = {
      agent: "scout", model: "inherit", thinking: "medium", toolAllowlist: null,
      systemPromptMode: null, identity: null, spawnable: null, autoExit: false,
      cwd: null, agentDir: null,
    };
    const { ctx } = setup();
    const resolved = resolveLoadoutModel({ loadout, config: parseSubagentConfig({}), catalog: testApi.buildModelCatalog(ctx) });
    const parts = ["pi"];
    testApi.applySandboxToParts(parts, loadout, {
      artifactDir: root, name: "scout", model: resolved.command, thinking: resolved.thinking,
    });
    assert.deepEqual(parts, ["pi", "--model", "'vendor/parent:medium'"]);
    const snapshotOnly = ["pi"];
    testApi.applySandboxToParts(snapshotOnly, loadout, { artifactDir: root, name: "scout" });
    assert.deepEqual(snapshotOnly, ["pi"], "the inherit token must never become a model CLI argument");
  });

  it("subagents_list reports the resolved model and its config source", async () => {
    writeModelSelection({ agentName: "scout", model: "vendor/cheap" });
    const { tools, ctx } = setup();
    const result = await tools.get("subagents_list").execute("test", {}, undefined, undefined, ctx);
    const scout = result.details.agents.find((agent: any) => agent.name === "scout");
    assert.equal(scout.effectiveModel, "vendor/cheap");
    assert.equal(scout.modelSource, "config-agent");
    assert.ok(result.content[0].text.includes("vendor/cheap · config agent"));
  });
});
