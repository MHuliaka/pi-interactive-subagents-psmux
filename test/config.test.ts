import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  INHERIT_TOKEN,
  parseSubagentConfig,
  parseModelToken,
  isModelAvailable,
  loadSubagentConfig,
  formatModelSource,
  resolveSubagentModel,
  resolveLoadoutModel,
  writeModelSelection,
  supportedThinkingLevels,
  clampThinkingLevel,
  type CatalogModel,
  type ModelCatalog,
  type ThinkingLevelName,
} from "../pi-extension/subagents/config.ts";
import { buildModelPickerItems, ModelPickerComponent } from "../pi-extension/subagents/model-picker.ts";
function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("config.ts", () => {

  /** Catalog helper: the first entry is the parent session's active model. */
  function makeCatalog(
    entries: string[],
    parentThinking: string | null = "low",
    options: {
      parentModel?: string | null;
      parentSupportedThinking?: readonly ThinkingLevelName[];
      capabilities?: Record<string, Omit<CatalogModel, "provider" | "id">>;
    } = {},
  ): ModelCatalog {
    return {
      parentModel:
        options.parentModel !== undefined ? options.parentModel : (entries[0] ?? null),
      parentThinking,
      parentSupportedThinking: options.parentSupportedThinking,
      available: entries.map((entry) => {
        const slash = entry.indexOf("/");
        const provider = entry.slice(0, slash);
        const id = entry.slice(slash + 1);
        return { provider, id, ...options.capabilities?.[id] };
      }),
    };
  }

  /** Temp config fixture: no test touches the real config.json. */
  function withConfigFixture(
    run: (paths: { configPath: string; examplePath: string }) => void,
  ): void {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }, null, 2));
      run({ configPath, examplePath });
    });
  }

  it("treats a missing models section as no configuration", () => {
    assert.deepEqual(parseSubagentConfig({ status: { enabled: true } }), { models: null });
    assert.deepEqual(parseSubagentConfig({}), { models: null });
  });

  it("applies defaults inside an empty models section", () => {
    assert.deepEqual(parseSubagentConfig({ models: { agents: {} } }), {
      models: { agents: {}, validate: true, fallback: "inherit" },
    });
  });

  it("accepts a thinking suffix on a model and keeps other colon ids intact", () => {
    assert.deepEqual(parseModelToken("vendor/alpha:low"), {
      base: "vendor/alpha",
      thinking: "low",
    });
    assert.deepEqual(parseModelToken("vendor/beta-flash:batch"), {
      base: "vendor/beta-flash:batch",
      thinking: null,
    });
  });

  it("rejects unsupported keys and invalid values", () => {
    assert.throws(() => parseSubagentConfig({ models: { nope: 1 } }), /unsupported key/);
    assert.throws(() => parseSubagentConfig({ models: { thinking: "extreme" } }), /models.thinking/);
    assert.throws(() => parseSubagentConfig({ models: { fallback: "maybe" } }), /models.fallback/);
    assert.throws(() => parseSubagentConfig({ models: { validate: "yes" } }), /boolean/);
    assert.throws(
      () => parseSubagentConfig({ models: { agents: { scout: { model: "  " } } } }),
      /non-empty/,
    );
    assert.throws(
      () => parseSubagentConfig({ models: { agents: { scout: { tool: "bash" } } } }),
      /unsupported key/,
    );
  });

  it("matches a model by provider/id or by bare id", () => {
    const available = [{ provider: "vendor", id: "alpha" }];
    assert.equal(isModelAvailable("vendor/alpha", available), true);
    assert.equal(isModelAvailable("ALPHA", available), true);
    assert.equal(isModelAvailable("vendor/other", available), false);
  });

  it("reports the thinking levels each model supports", () => {
    assert.deepEqual(
      supportedThinkingLevels({ reasoning: false, thinkingLevelMap: { high: "high" } }),
      ["off"],
      "a non-reasoning model only supports off even with a map",
    );
    assert.deepEqual(
      supportedThinkingLevels({ reasoning: true }),
      ["off", "minimal", "low", "medium", "high"],
      "xhigh and max require an explicit map entry",
    );
    assert.deepEqual(
      supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { medium: null } }),
      ["off", "minimal", "low", "high"],
      "a null map entry excludes that level",
    );
    assert.deepEqual(
      supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      "an explicit xhigh/max entry includes it",
    );
  });

  it("clamps a thinking level to the nearest supported one", () => {
    assert.equal(clampThinkingLevel("max", ["off", "low"]), "low", "highest supported at or below wins");
    assert.equal(
      clampThinkingLevel("minimal", ["low", "high"]),
      "low",
      "with nothing below the request the lowest supported wins",
    );
    assert.equal(clampThinkingLevel("high", []), "off", "an empty support set collapses to off");
    assert.equal(clampThinkingLevel("medium", ["off", "medium", "max"]), "medium", "an exact match is preserved");
  });

  it("resolves config agent before param, config before frontmatter", () => {
    const config = parseSubagentConfig({
      models: {
        default: "vendor/beta",
        agents: { scout: { model: "vendor/alpha" } },
      },
    });
    const catalog = makeCatalog([
      "vendor/gamma",
      "vendor/beta",
      "vendor/alpha",
      "vendor/from-file",
    ]);
    const base = {
      agentName: "scout",
      agentModel: "vendor/from-file",
      agentThinking: "high",
      config,
      catalog,
    };

    const pinned = resolveSubagentModel({ ...base, param: "vendor/gamma" });
    assert.equal(pinned.source, "config-agent");
    assert.equal(pinned.command, "vendor/alpha");

    assert.equal(resolveSubagentModel({ ...base, param: null }).source, "config-agent");
    assert.equal(resolveSubagentModel({ ...base, param: null }).command, "vendor/alpha");

    const noAgentEntry = parseSubagentConfig({ models: { default: "vendor/beta" } });
    assert.equal(
      resolveSubagentModel({ ...base, config: noAgentEntry, param: null }).source,
      "config-default",
    );
    assert.equal(
      resolveSubagentModel({ ...base, config: noAgentEntry, param: "vendor/gamma" }).source,
      "param",
    );

    const noConfig = parseSubagentConfig({});
    const fromFile = resolveSubagentModel({ ...base, config: noConfig, param: null });
    assert.equal(fromFile.source, "agent");
    assert.equal(fromFile.command, "vendor/from-file");
    assert.equal(fromFile.thinking, "high");

    const nothing = resolveSubagentModel({ ...base, agentModel: null, config: noConfig, param: null });
    assert.equal(nothing.source, "unset");
    assert.equal(nothing.command, null);
  });

  it("warns when a config-pinned agent ignores the spawn param", () => {
    const config = parseSubagentConfig({
      models: { agents: { scout: { model: "vendor/alpha" } } },
    });
    const catalog = makeCatalog(["vendor/alpha", "vendor/gamma"]);
    const base = {
      agentName: "scout",
      agentModel: "vendor/from-file",
      agentThinking: null,
      config,
      catalog,
    };

    const pinned = resolveSubagentModel({ ...base, param: "vendor/gamma" });
    assert.equal(pinned.source, "config-agent");
    assert.equal(pinned.token, "vendor/alpha");
    assert.match(pinned.warning ?? "", /vendor\/gamma/);
    assert.match(pinned.warning ?? "", /scout/);
    assert.match(pinned.warning ?? "", /vendor\/alpha/);

    const noAgentEntry = parseSubagentConfig({ models: { default: "vendor/beta" } });
    const fromParam = resolveSubagentModel({ ...base, config: noAgentEntry, param: "vendor/gamma" });
    assert.equal(fromParam.source, "param");
    assert.equal(fromParam.warning, null);

    const equal = resolveSubagentModel({ ...base, param: "vendor/alpha" });
    assert.equal(equal.source, "config-agent");
    assert.equal(equal.warning, null);
  });

  it("keeps the resolved command unchanged when no models section exists", () => {
    // The non-invasive invariant: an absent section must not validate, warn, or
    // rewrite anything, even when the model is absent from the catalogue.
    const resolved = resolveSubagentModel({
      param: null,
      agentName: "scout",
      agentModel: "vendor/beta",
      agentThinking: "low",
      config: parseSubagentConfig({}),
      catalog: makeCatalog(["vendor/alpha"]),
    });
    assert.equal(resolved.command, "vendor/beta");
    assert.equal(resolved.token, "vendor/beta");
    assert.equal(resolved.warning, null);
    assert.equal(resolved.error, null);
  });

  it("resolves the inherit token against the parent session", () => {
    const config = parseSubagentConfig({ models: { agents: { scout: { model: INHERIT_TOKEN } } } });
    const resolved = resolveSubagentModel({
      param: null,
      agentName: "scout",
      agentModel: "vendor/beta",
      agentThinking: "high",
      config,
      catalog: makeCatalog(["vendor/alpha"]),
    });
    // The token is what gets persisted; the command is what runs now.
    assert.equal(resolved.token, INHERIT_TOKEN);
    assert.equal(resolved.command, "vendor/alpha");
    assert.equal(resolved.inherited, true);
    assert.equal(resolved.thinking, "high", "an explicit thinking level still wins");
  });

  it("falls back in ladder order and refuses when the policy is fail", () => {
    const config = parseSubagentConfig({
      models: { default: "vendor/alpha", fallback: "default" },
    });
    // A spawn parameter outranks `models.default`, so the unavailable model wins
    // the chain and the ladder has to run.
    const fallback = resolveSubagentModel({
      param: "vendor/missing",
      agentName: null,
      agentModel: null,
      agentThinking: null,
      config,
      catalog: makeCatalog(["vendor/alpha"]),
    });
    assert.equal(fallback.command, "vendor/alpha");
    assert.equal(fallback.source, "fallback");
    assert.match(fallback.warning ?? "", /not available/);

    const strict = parseSubagentConfig({ models: { fallback: "fail" } });
    const failed = resolveSubagentModel({
      param: "vendor/missing",
      agentName: null,
      agentModel: null,
      agentThinking: null,
      config: strict,
      catalog: makeCatalog(["vendor/alpha"]),
    });
    assert.equal(failed.command, null);
    assert.match(failed.error ?? "", /not available/);
  });

  it("re-resolves the inherit token when a snapshot is resumed", () => {
    const config = parseSubagentConfig({ models: {} });
    const loadout = { model: INHERIT_TOKEN, thinking: null, agent: "scout" };

    const underA = resolveLoadoutModel({
      loadout,
      config,
      catalog: makeCatalog(["vendor/alpha", "vendor/alpha"]),
    });
    const underB = resolveLoadoutModel({
      loadout,
      config,
      catalog: makeCatalog(["vendor/gamma", "vendor/gamma"]),
    });

    assert.equal(underA.command, "vendor/alpha");
    assert.equal(underB.command, "vendor/gamma");
    assert.equal(underA.token, INHERIT_TOKEN, "the snapshot keeps the token");

    // A literal snapshot replays unchanged.
    const literal = resolveLoadoutModel({
      loadout: { model: "vendor/alpha", thinking: "low", agent: null },
      config,
      catalog: makeCatalog(["vendor/alpha"]),
    });
    assert.equal(literal.command, "vendor/alpha");
    assert.equal(literal.thinking, "low");
  });

  it("prefers the current config over the loadout snapshot on resume", () => {
    const catalog = makeCatalog(["vendor/alpha", "vendor/beta", "vendor/from-file"]);
    const loadout = { model: "vendor/from-file", thinking: "low", agent: "scout" };

    const agentConfig = parseSubagentConfig({
      models: { agents: { scout: { model: "vendor/beta", thinking: "high" } }, default: "vendor/alpha" },
    });
    const fromAgent = resolveLoadoutModel({ loadout, config: agentConfig, catalog });
    assert.equal(fromAgent.source, "config-agent");
    assert.equal(fromAgent.command, "vendor/beta");
    assert.equal(fromAgent.thinking, "high", "a config thinking level overrides the snapshot");

    const defaultConfig = parseSubagentConfig({ models: { default: "vendor/alpha" } });
    const fromDefault = resolveLoadoutModel({ loadout, config: defaultConfig, catalog });
    assert.equal(fromDefault.source, "config-default");
    assert.equal(fromDefault.command, "vendor/alpha");
    assert.equal(fromDefault.thinking, "low", "with no config thinking the snapshot level survives");

    const fromSnapshot = resolveLoadoutModel({ loadout, config: parseSubagentConfig({}), catalog });
    assert.equal(fromSnapshot.source, "snapshot");
    assert.equal(fromSnapshot.command, "vendor/from-file");
    assert.equal(fromSnapshot.thinking, "low", "the snapshot level survives when nothing overrides it");
  });

  it("clamps an unsupported thinking level and warns when validating", () => {
    const catalog = makeCatalog(["vendor/reasoner", "vendor/plain"], "low", {
      parentSupportedThinking: ["off", "minimal", "low", "medium"],
      capabilities: {
        reasoner: { reasoning: true, supportedThinking: ["off", "low", "medium", "high"] },
      },
    });
    const config = parseSubagentConfig({
      models: { agents: { scout: { model: "vendor/reasoner", thinking: "max" } } },
    });
    const clamped = resolveSubagentModel({
      param: null,
      agentName: "scout",
      agentModel: null,
      agentThinking: null,
      config,
      catalog,
    });
    assert.equal(clamped.command, "vendor/reasoner");
    assert.equal(clamped.thinking, "high", "max is clamped to the highest supported level");
    assert.match(clamped.warning ?? "", /Thinking level "max"/);

    const unknown = parseSubagentConfig({
      models: { agents: { scout: { model: "vendor/plain", thinking: "max" } } },
    });
    const unclamped = resolveSubagentModel({
      param: null,
      agentName: "scout",
      agentModel: null,
      agentThinking: null,
      config: unknown,
      catalog,
    });
    assert.equal(unclamped.thinking, "max", "an unknown capability is left alone");
    assert.equal(unclamped.warning, null);
  });

  it("resolves a non-reasoning model to off and warns when a level was configured", () => {
    const catalog = makeCatalog(["vendor/text"], null, {
      parentModel: null,
      capabilities: {
        text: { reasoning: false, supportedThinking: ["off"] },
      },
    });
    const configured = parseSubagentConfig({
      models: { agents: { scout: { model: "vendor/text", thinking: "high" } } },
    });
    const resolved = resolveSubagentModel({
      param: null,
      agentName: "scout",
      agentModel: null,
      agentThinking: null,
      config: configured,
      catalog,
    });
    assert.equal(resolved.command, "vendor/text");
    assert.equal(resolved.thinking, "off");
    assert.match(resolved.warning ?? "", /not supported/);

    const unset = parseSubagentConfig({ models: { agents: { scout: { model: "vendor/text" } } } });
    const explicitOff = resolveSubagentModel({
      param: null,
      agentName: "scout",
      agentModel: null,
      agentThinking: null,
      config: unset,
      catalog,
    });
    assert.equal(explicitOff.thinking, "off", "a non-reasoning model resolves to an explicit off");
    assert.equal(explicitOff.warning, null);
  });

  it("clamps inherit thinking against the parent model's supported levels", () => {
    const catalog = makeCatalog(["vendor/parent"], "medium", {
      parentSupportedThinking: ["off", "low", "medium"],
    });
    const config = parseSubagentConfig({
      models: { agents: { scout: { model: INHERIT_TOKEN, thinking: "max" } } },
    });
    const resolved = resolveSubagentModel({
      param: null,
      agentName: "scout",
      agentModel: null,
      agentThinking: null,
      config,
      catalog,
    });
    assert.equal(resolved.inherited, true);
    assert.equal(resolved.thinking, "medium", "clamped to the parent's highest supported level");
    assert.match(resolved.warning ?? "", /Thinking level "max"/);
  });

  it("sets thinking while preserving the model and other entry keys", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      writeFileSync(
        configPath,
        JSON.stringify({ models: { agents: { scout: { model: "vendor/alpha", tier: "fast" } } } }),
      );

      const result = writeModelSelection({ agentName: "scout", thinking: "high", configPath, examplePath });
      assert.equal(result.changed, true);
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.models.agents.scout, {
        model: "vendor/alpha",
        tier: "fast",
        thinking: "high",
      });
    });
  });

  it("clears one field without touching the other", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      writeFileSync(
        configPath,
        JSON.stringify({ models: { agents: { scout: { model: "vendor/alpha", thinking: "high" } } } }),
      );

      writeModelSelection({ agentName: "scout", thinking: null, configPath, examplePath });
      let parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.models.agents.scout, { model: "vendor/alpha" });

      // Restore the level, then clear only the model and keep thinking.
      writeModelSelection({ agentName: "scout", thinking: "high", configPath, examplePath });
      writeModelSelection({ agentName: "scout", model: null, configPath, examplePath });
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.models.agents.scout, { thinking: "high" });
    });
  });

  it("deletes an agent entry that becomes empty after a clear", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      writeFileSync(
        configPath,
        JSON.stringify({ models: { agents: { scout: { model: "vendor/alpha" } } } }),
      );

      const result = writeModelSelection({ agentName: "scout", model: null, configPath, examplePath });
      assert.equal(result.changed, true);
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.models.agents, {});
    });
  });

  it("supports setting and clearing only the global thinking level", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      const set = writeModelSelection({ agentName: null, thinking: "low", configPath, examplePath });
      assert.equal(set.changed, true);
      let parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(parsed.models.thinking, "low");
      assert.equal(parsed.models.default, undefined, "global thinking stands alone without a default model");

      const cleared = writeModelSelection({ agentName: null, thinking: null, configPath, examplePath });
      assert.equal(cleared.changed, true);
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(parsed.models.thinking, undefined);
    });
  });

  it("reports changed false when a write is a no-op", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      writeFileSync(
        configPath,
        JSON.stringify({ models: { agents: { scout: { model: "vendor/alpha", thinking: "high" } } } }),
      );
      const before = readFileSync(configPath, "utf8");

      const result = writeModelSelection({
        agentName: "scout",
        model: "vendor/alpha",
        thinking: "high",
        configPath,
        examplePath,
      });

      assert.equal(result.changed, false);
      assert.equal(readFileSync(configPath, "utf8"), before, "a no-op must not rewrite");
    });
  });

  it("reads the legacy package config and migrates it on write", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "subagents.json");
      const legacyPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }));
      writeFileSync(
        legacyPath,
        JSON.stringify({
          status: { enabled: true },
          models: { agents: { scout: { model: "vendor/legacy" } } },
        }),
      );

      const loaded = loadSubagentConfig(configPath, examplePath, legacyPath);
      assert.equal(loaded.models?.agents.scout?.model, "vendor/legacy");

      const result = writeModelSelection({
        agentName: "worker",
        model: "vendor/alpha",
        configPath,
        examplePath,
        legacyPath,
      });
      assert.equal(result.changed, true);
      assert.equal(result.path, configPath, "the write lands in the durable path");

      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.status, { enabled: true }, "the legacy status survives the migration");
      assert.equal(parsed.models.agents.scout.model, "vendor/legacy");
      assert.equal(parsed.models.agents.worker.model, "vendor/alpha");
    });
  });

  it("builds sorted picker items and flags the current model", () => {
    const items = buildModelPickerItems({
      models: [
        { provider: "vendor", id: "beta", name: "Beta" },
        { provider: "vendor", id: "alpha" },
        { provider: "vendor", id: "beta" },
      ],
      currentValue: "vendor/beta",
      leadingItems: [{ value: INHERIT_TOKEN, label: "inherit", searchText: "inherit" }],
    });

    assert.deepEqual(
      items.map((item) => item.value),
      [INHERIT_TOKEN, "vendor/alpha", "vendor/beta"],
      "leading rows come first, duplicates collapse, models sort",
    );
    assert.equal(items.find((item) => item.value === "vendor/beta")?.current, true);
    assert.equal(items.find((item) => item.value === "vendor/alpha")?.current, false);
  });

  it("bounds the picker list and marks the current model", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const models = Array.from({ length: 40 }, (_, index) => ({
      provider: "vendor",
      id: `model-${String(index).padStart(2, "0")}`,
    }));
    const items = buildModelPickerItems({ models, currentValue: "vendor/model-30" });

    const component = new ModelPickerComponent(theme, { title: "model", items, maxVisible: 10 }, () => {});
    const lines = component.render(80);
    const modelRows = lines.filter((line) => line.includes("vendor/model-"));

    assert.ok(modelRows.length <= 10, `the view stays bounded, got ${modelRows.length} model rows`);
    assert.ok(lines.some((line) => line.includes("(31/40)")), "a scroll indicator shows the position");
    assert.ok(
      lines.some((line) => line.includes("●") && line.includes("vendor/model-30")),
      "the current model is marked",
    );
  });

  it("writes a selection, preserves other keys, and supports reset", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      // No config.json yet: it is created from the example.
      const first = writeModelSelection({
        agentName: "scout",
        model: INHERIT_TOKEN,
        configPath,
        examplePath,
      });
      const second = writeModelSelection({
        agentName: null,
        model: "vendor/alpha",
        configPath,
        examplePath,
      });
      assert.equal(first.changed, true);
      assert.equal(second.changed, true);

      let parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.status, { enabled: true }, "status survives the write");
      assert.equal(parsed.models.default, "vendor/alpha");
      assert.deepEqual(parsed.models.agents, { scout: { model: INHERIT_TOKEN } });

      // Reset removes only the agent entry.
      const reset = writeModelSelection({
        agentName: "scout",
        model: null,
        configPath,
        examplePath,
      });
      assert.equal(reset.changed, true);
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.models.agents, {});
      assert.equal(parsed.models.default, "vendor/alpha");
    });
  });

  it("replaces a shorthand agent entry instead of throwing on it", () => {
    // "scout": "inherit" is a plausible hand-written shorthand. Writing through
    // the picker must repair the entry, not crash on a string primitive.
    withConfigFixture(({ configPath, examplePath }) => {
      writeFileSync(
        configPath,
        JSON.stringify({ models: { agents: { scout: INHERIT_TOKEN } } }, null, 2),
      );

      const result = writeModelSelection({
        agentName: "scout",
        model: "vendor/alpha",
        configPath,
        examplePath,
      });

      assert.equal(result.changed, true);
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.models.agents, { scout: { model: "vendor/alpha" } });
    });
  });

  it("keeps unrelated keys of a repaired agent entry", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      writeFileSync(
        configPath,
        JSON.stringify({ models: { agents: { scout: { thinking: "high" } } } }, null, 2),
      );

      writeModelSelection({ agentName: "scout", model: "vendor/alpha", configPath, examplePath });

      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.models.agents.scout, { thinking: "high", model: "vendor/alpha" });
    });
  });

  it("does not create a config file when there is nothing to reset", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      const legacyPath = join(dir, "legacy-config.json");
      writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }));

      const result = writeModelSelection({
        agentName: "scout",
        model: null,
        configPath,
        examplePath,
        legacyPath,
      });

      assert.equal(result.changed, false);
      assert.equal(existsSync(configPath), false, "a reset must not create the file");
    });
  });

  it("clears a legacy-only entry by migrating it to the durable path", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "subagents.json");
      const examplePath = join(dir, "config.json.example");
      const legacyPath = join(dir, "config.json");
      writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }));
      writeFileSync(
        legacyPath,
        JSON.stringify({
          status: { enabled: true },
          models: { agents: { scout: { model: "vendor/legacy" } } },
        }),
      );

      const result = writeModelSelection({
        agentName: "scout",
        model: null,
        configPath,
        examplePath,
        legacyPath,
      });

      assert.equal(result.changed, true);
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(parsed.models.agents, {}, "the cleared entry is gone from the migrated file");
      assert.deepEqual(parsed.status, { enabled: true });
    });
  });

  it("reports changed false when the entry to clear is already absent", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      writeFileSync(configPath, JSON.stringify({ models: { agents: { worker: {} } } }, null, 2));
      const before = readFileSync(configPath, "utf8");

      const result = writeModelSelection({
        agentName: "scout",
        model: null,
        configPath,
        examplePath,
      });

      assert.equal(result.changed, false);
      assert.equal(readFileSync(configPath, "utf8"), before, "a no-op reset must not rewrite");
    });
  });

  it("rejects an unsafe agent name before touching the filesystem", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      assert.throws(
        () => writeModelSelection({ agentName: "../escape", model: "inherit", configPath, examplePath }),
        /unsafe agent name/,
      );
      assert.equal(existsSync(configPath), false, "the guard must run before the write");
    });
  });

  it("names the offending file when the config JSON is broken", () => {
    withConfigFixture(({ configPath, examplePath }) => {
      writeFileSync(configPath, "{\n");
      assert.throws(
        () => writeModelSelection({ agentName: "scout", model: "vendor/alpha", configPath, examplePath }),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("names the file in models validation errors", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify({ models: { thinking: "extreme" } }));
      assert.throws(
        () => loadSubagentConfig(configPath, join(dir, "config.json.example")),
        /Invalid subagent config in .*config\.json: models\.thinking/,
      );
    });
  });

  it("labels every resolution source", () => {
    const sources = [
      "param",
      "config-agent",
      "config-default",
      "agent",
      "snapshot",
      "fallback",
      "unset",
    ] as const;
    for (const source of sources) {
      assert.equal(typeof formatModelSource(source), "string");
      assert.notEqual(formatModelSource(source), "");
    }
    assert.equal(formatModelSource("config-agent"), "config agent");
  });

});
