import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgentDefinitions } from "../pi-extension/subagents/agents.ts";
import { buildInitialPrompts } from "../pi-extension/subagents/prompts.ts";

it("discovers package/global/project profiles with correct priority and CRLF parsing", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-profiles-"));
  const previousCwd = process.cwd();
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const global = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(join(global, "agents"), { recursive: true });
    mkdirSync(join(project, ".pi", "agents"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = global;
    process.chdir(project);
    writeFileSync(join(global, "agents", "worker.md"), "---\nname: worker\nmodel: global/model\n---\nGlobal instructions");
    writeFileSync(join(project, ".pi", "agents", "worker.md"), "---\r\nname: worker\r\nmodel: project/model\r\nauto-exit: false\r\ninteractive: false\r\nsession-mode: fork\r\nsubagent_agents: scout, researcher\r\nsystem-prompt: replace\r\ndisable-model-invocation: true\r\n---\r\nProject instructions");
    const definitions = discoverAgentDefinitions();
    const worker = definitions.find((d) => d.name === "worker")!;
    assert.equal(worker.source, "project");
    assert.equal(worker.model, "project/model");
    assert.equal(worker.autoExit, false);
    assert.equal(worker.interactive, false);
    assert.equal(worker.sessionMode, "fork");
    assert.equal(worker.systemPromptMode, "replace");
    assert.equal(worker.disableModelInvocation, true);
    assert.deepEqual(worker.subagentAgents, ["scout", "researcher"]);
    assert.equal(worker.body, "Project instructions");
    assert.ok(definitions.some((d) => d.name === "scout" && d.source === "package"));
  } finally {
    process.chdir(previousCwd);
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves the old CLI skill/task message order and delegates skill expansion to Pi", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-skills-"));
  try {
    const first = join(root, "one.md");
    const second = join(root, "two.md");
    writeFileSync(first, "---\r\nname: one\r\ndescription: first\r\n---\r\nFirst instructions");
    writeFileSync(second, "---\nname: two\ndescription: second\n---\nSecond instructions");
    const commands = [
      { name: "skill:one", source: "skill", sourceInfo: { path: first } },
      { name: "skill:two", source: "skill", sourceInfo: { path: second } },
    ];
    assert.deepEqual(buildInitialPrompts("Do the task", "one,two", commands, true), ["Do the task", "/skill:one", "/skill:two"]);
    assert.deepEqual(buildInitialPrompts("Do the task", "one,two", commands, false), ["/skill:one", "/skill:two", "Do the task"]);
    assert.deepEqual(buildInitialPrompts("task", undefined, [], false), ["task"]);
    assert.throws(() => buildInitialPrompts("task", "missing", commands, false), /not available/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
