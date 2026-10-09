import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { discoverAgentDefinitions, type AgentDefaults } from "./agents.ts";
import { readNameRegistry, registerName, readSubagentLoadout, writeSubagentLoadout, seedSubagentSessionFile, getActiveSessionEntries, getSessionId, summarizeSessionStats, type SubagentLoadout } from "./session.ts";
import { INHERIT_TOKEN, THINKING_LEVELS, findAvailableModel, formatModelSource, loadSubagentConfig, resolveLoadoutModel, resolveSubagentModel, supportedThinkingLevels, writeModelSelection, type ModelCatalog, type ResolvedModel, type SubagentConfig, type ThinkingLevelName } from "./config.ts";
import { buildModelPickerItems, ModelPickerComponent, type ModelPickerItem, type ModelPickerModel } from "./model-picker.ts";
import { PiRpc, type RpcRecord } from "./rpc.ts";
import { Subagent } from "./runtime.ts";
import { SubagentScreen, SubagentWidget, guardComponent, orderAgents, clean } from "./view.ts";
import { buildTaskWithSkills } from "./prompts.ts";
import { ChildDialog } from "./dialog.ts";
import { SUBAGENT_SHORTCUT } from "./shortcuts.ts";
import { RemoteConnection, TreeBridge, type TreePacket } from "./tree.ts";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const SPAWNING_TOOLS = ["subagent", "subagent_message", "subagents_list"];
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();
let latestPi: ExtensionAPI | undefined;

export function registerToolExtension(name: string, path: string) {
  if (BUILTIN_TOOLS.has(name) || SPAWNING_TOOLS.includes(name) || ["codemode", "tool_search", "ask_question"].includes(name)) throw new Error(`Cannot override built-in tool ${name}`);
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing && existing !== path) throw new Error(`Tool extension already registered for ${name}`);
  EXTRA_TOOL_EXTENSIONS.set(name, path);
}
(globalThis as any).__pi_interactive_subagents = { registerToolExtension };

function getToolExtensionPath(tool: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  if (["codemode", "tool_search"].includes(tool)) return `builtin:${tool}`;
  if (SPAWNING_TOOLS.includes(tool)) return fileURLToPath(import.meta.url);
  if (tool === "ask_question") return join(SUBAGENTS_DIR, "control.ts");
  if (tool === "safe_bash") return join(SUBAGENTS_DIR, "tools", "safe-bash.ts");
  if (EXTRA_TOOL_EXTENSIONS.has(tool)) return EXTRA_TOOL_EXTENSIONS.get(tool);
  const path = join(getAgentDir(), "extensions", tool.replace(/_/g, "-"), "index.ts");
  return existsSync(path) ? path : undefined;
}

const SubagentParams = Type.Object({
  agent: Type.String({ description: "Agent profile to launch (worker, scout, researcher, or a custom profile)." }),
  task: Type.String({ description: "Task for the subagent." }),
  name: Type.Optional(Type.String({ description: "Unique display name and persistent follow-up handle." })),
  model: Type.Optional(Type.String({ description: "Model override, subject to /subagent-model configuration." })),
  cwd: Type.Optional(Type.String({ description: "Working directory; relative paths resolve from the parent cwd." })),
});

function applySandboxToParts(parts: string[], loadout: SubagentLoadout, opts: { artifactDir: string; name: string; model?: string | null; thinking?: string | null }) {
  const model = opts.model !== undefined ? opts.model : loadout.model;
  const thinking = opts.thinking !== undefined ? opts.thinking : loadout.thinking;
  if (model && model !== INHERIT_TOKEN) parts.push("--model", model);
  if (thinking) parts.push("--thinking", thinking);
  if (loadout.identity) {
    const path = join(opts.artifactDir, "context", `${randomUUID()}-system.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, loadout.identity, "utf8");
    parts.push(loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", path);
  }
  if (loadout.toolAllowlist) {
    parts.push("--no-extensions", "--no-mcp", "--tools", loadout.toolAllowlist);
    const paths = new Set<string>();
    for (const tool of loadout.toolAllowlist.split(",")) {
      const path = getToolExtensionPath(tool);
      if (path && (path.startsWith("builtin:") || existsSync(path))) paths.add(path);
    }
    for (const path of paths) parts.push("-e", path);
  }
}

const CLEANUP_KEY = Symbol.for("pi-subagents/rpc-cleanup");
// Old runtime closures must not survive /reload.
(globalThis as any)[CLEANUP_KEY]?.();

export default function subagentsExtension(pi: ExtensionAPI, dependencies: { createRpc?: (args: string[], options: SpawnOptionsWithoutStdio) => PiRpc } = {}) {
  latestPi = pi;
  const agents = new Map<string, Subagent>();
  let ctx: ExtensionContext | undefined;
  let disposed = false;
  let opening = false;
  let screen: SubagentScreen | undefined;
  let dismiss: (() => void) | undefined;
  let removeViewInput: (() => void) | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let dialogQueue = Promise.resolve();
  let dialogActive = false;
  let dialogAgent: Subagent | undefined;
  let cancelDialog: (() => void) | undefined;
  let pickerAbort: AbortController | undefined;
  const reportedErrors = new Set<string>();
  const byId = (id: string) => Array.from(agents.values()).find((a) => a.id === id);
  let bridge = new TreeBridge(byId, observeTree, (error) => reportError(undefined, error));

  function reportError(agent: Subagent | undefined, error: unknown) {
    if (disposed) return;
    const text = error instanceof Error ? error.message : String(error);
    pickerAbort?.abort();
    try { dismiss?.(); } catch { /* Continue restoring/reporting through the parent UI. */ }
    try { cancelDialog?.(); } catch { /* A dead dialog must not block reporting. */ }
    if (bridge.hasParent) { bridge.fault(agent, text); return; }
    const key = `${agent?.id ?? "ui"}:${text}`;
    if (reportedErrors.has(key) || (!agent && Array.from(reportedErrors).some((key) => key.endsWith(`:${text}`)))) return;
    reportedErrors.add(key);
    if (reportedErrors.size > 500) reportedErrors.delete(reportedErrors.values().next().value!);
    try { pi.sendMessage({ customType: "subagent_error", content: `${agent ? `Subagent "${agent.name}"` : "Subagents"} error:\n\n${text}\n\nReturned to the main agent.`, display: true }, { triggerTurn: false, deliverAs: "steer" }); }
    catch { try { ctx?.ui.notify(clean(text), "error"); } catch { console.error(text); } }
  }

  function sendToChat(agent: Subagent, message: Parameters<ExtensionAPI["sendMessage"]>[0]) {
    try { pi.sendMessage(message, { triggerTurn: !agent.rpc?.remote, deliverAs: "steer" }); }
    catch (error) { reportError(agent, error); }
  }

  async function withErrors<T>(agent: Subagent | undefined, action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { reportError(agent, error); throw error; }
  }

  function descendants(parent: Subagent) {
    return Array.from(agents.values()).filter((candidate) => {
      const seen = new Set<string>();
      let id = candidate.parentId;
      while (id && !seen.has(id)) {
        if (id === parent.id) return true;
        seen.add(id);
        id = byId(id)?.parentId;
      }
      return false;
    });
  }

  function closeDescendantViews(parent: Subagent) {
    if (!["completed", "cancelled", "failed"].includes(parent.phase)) return;
    if (dialogAgent === parent) cancelDialog?.();
    for (const child of descendants(parent)) {
      if (!(child.rpc instanceof RemoteConnection) || child.rpc.exitConfirmed) continue;
      if (!child.rpc.markClosing()) continue;
      if (dialogAgent === child) cancelDialog?.();
      child.phase = parent.phase === "cancelled" ? "cancelled" : "failed";
      child.activity = "ancestor closing";
      child.emit("settled");
      child.changed();
    }
  }

  function finishDescendants(parent: Subagent) {
    for (const child of descendants(parent)) {
      if (!(child.rpc instanceof RemoteConnection) || child.rpc.exitConfirmed) continue;
      const cancelled = parent.phase === "cancelled";
      const error = cancelled ? undefined : `Ancestor "${parent.name}" ${parent.phase} before "${child.name}" exited${parent.error ? `: ${parent.error}` : "."}`;
      if (child.rpc.pid && child.rpc.pid !== process.pid) {
        try { process.kill(child.rpc.pid); } catch (failure: any) { if (failure?.code !== "ESRCH") reportError(child, failure); }
      }
      child.rpc.end({ code: cancelled ? 0 : 1, phase: cancelled ? "cancelled" : "failed", error });
      if (error) reportError(child, error);
    }
  }

  function observeTree(owner: Subagent, packet: TreePacket) {
    if (disposed || !ctx || !(owner.rpc instanceof PiRpc)) return;
    const id = packet.route.at(-1)!;
    if (packet.kind === "fault") { reportError(byId(id) ?? owner, packet.error || "Unknown nested subagent error"); return; }
    if (packet.route.length < 2) throw new Error("Invalid descendant route");
    if (packet.kind === "spawn") {
      const parent = byId(packet.route.at(-2)!);
      const node = packet.node;
      if (!parent || !node || typeof node.name !== "string" || !node.name || /[/\\\x00-\x1f\x7f-\x9f]/.test(node.name) || typeof node.agent !== "string" || typeof node.task !== "string" || !isAbsolute(node.sessionFile) || (node.pid !== undefined && (!Number.isSafeInteger(node.pid) || node.pid <= 0 || node.pid === process.pid))) throw new Error("Invalid nested subagent announcement");
      const name = `${parent.name}/${node.name}`;
      const existing = agents.get(name);
      if (existing && !existing.finishedAt && existing.rpc) throw new Error(`Nested subagent handle collision: ${name}`);
      const connection = new RemoteConnection(owner.rpc, packet.route.slice(1), node.pid);
      const agent = new Subagent(name, node.agent, node.task, node.sessionFile, node.autoExit, connection, id);
      agent.parentId = parent.id;
      agent.depth = parent.depth + 1;
      agent.model = node.model;
      agent.thinking = node.thinking;
      attach(agent, ctx);
      try { registerName(artifactDir(ctx), name, { sessionFile: node.sessionFile, sessionId: getSessionId(node.sessionFile) }); }
      catch (error) { reportError(agent, error); }
      if (!parent.live) { closeDescendantViews(parent); if (parent.finishedAt) finishDescendants(parent); }
      return;
    }
    const agent = byId(id);
    if (!agent || !(agent.rpc instanceof RemoteConnection) || agent.rpc.owner !== owner.rpc || agent.rpc.route.join("/") !== packet.route.slice(1).join("/")) throw new Error("Unknown nested subagent route");
    if (packet.kind === "record" && packet.record && typeof packet.record.type === "string") agent.rpc.receive(packet.record);
    else if (packet.kind === "closed" && packet.result && ["completed", "cancelled", "failed"].includes(packet.result.phase ?? "")) agent.rpc.end(packet.result);
    else throw new Error("Invalid nested subagent event");
  }
  const artifactDir = (context: ExtensionContext) => join(context.sessionManager.getSessionDir(), "artifacts", context.sessionManager.getSessionId());
  const liveCount = () => Array.from(agents.values()).filter((a) => a.live && !a.rpc?.remote).length;
  const publishChildren = () => {
    if (process.env.PI_SUBAGENT_ID && !disposed) {
      try { pi.appendEntry("subagent_children", { count: liveCount() }); }
      catch (error) { reportError(undefined, error); }
    }
  };

  const updateWidget = () => {
    if (disposed || ctx?.mode !== "tui") return;
    try { ctx.ui.setWidget("subagent-status", agents.size
      ? () => new SubagentWidget(() => Array.from(agents.values()), (agent) => { void openView(agent); }, (error) => reportError(undefined, error))
      : undefined); }
    catch (error) { reportError(undefined, error); }
  };

  async function openView(agent?: Subagent) {
    if (!ctx || ctx.mode !== "tui" || disposed || opening || dialogActive) return;
    const context = ctx;
    opening = true;
    try {
      if (!agent) {
        const items = orderAgents(Array.from(agents.values()));
        if (!items.length) { context.ui.notify("No subagents yet. Use /subagent <profile> <task>.", "info"); return; }
        pickerAbort = new AbortController();
        const name = await pickModelChoice(context, "Subagents — select to open", items.map((a) => ({ value: a.name, label: `${"  ".repeat(a.depth)}${a.depth ? "↳ " : ""}${a.name} (${a.agent}) · ${a.phase}`, searchText: `${a.name} ${a.agent} ${a.phase}` })), pickerAbort.signal, (error) => reportError(undefined, error));
        pickerAbort = undefined;
        agent = name ? agents.get(name) : undefined;
      }
      if (!agent || disposed || context !== ctx) return;
      const selected = agent;
      await context.ui.custom<void>((tui, theme, _keys, done) => {
        const close = () => {
          const current = screen;
          screen = undefined;
          dismiss = undefined;
          try { removeViewInput?.(); }
          catch (error) { reportError(selected, error); }
          finally { removeViewInput = undefined; current?.dispose(); done(); }
        };
        screen = new SubagentScreen(tui, theme, selected, close);
        dismiss = () => screen?.close();
        // Consume exit/navigation keys before Pi's parent interrupt/exit handling.
        removeViewInput = context.ui.onTerminalInput((data) => {
          if (["escape", "ctrl+c", "ctrl+d", SUBAGENT_SHORTCUT].some((key) => matchesKey(data, key as any))) {
            screen?.handleInput(data);
            return { consume: true };
          }
          return undefined;
        });
        return screen;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
    } catch (error) { reportError(agent, error); }
    finally {
      pickerAbort = undefined;
      try { removeViewInput?.(); } catch (error) { reportError(agent, error); }
      removeViewInput = undefined;
      screen?.dispose();
      screen = undefined;
      dismiss = undefined;
      opening = false;
    }
  }

  async function cleanup() {
    if (disposed) return;
    disposed = true;
    pickerAbort?.abort();
    try { dismiss?.(); } catch { /* UI teardown must never prevent process cleanup. */ }
    try { cancelDialog?.(); } catch { /* Exit listeners will also release dialogs. */ }
    if (interval) clearInterval(interval);
    try { ctx?.ui.setWidget("subagent-status", undefined); } catch { /* Parent UI is already closing. */ }
    try {
      await Promise.all(Array.from(agents.values()).filter((a) => a.rpc instanceof PiRpc && !a.finishedAt).map(async (a) => {
        try { await a.stop(); } catch { if (a.rpc instanceof PiRpc) await a.rpc.stop(); }
      }));
      await dialogQueue;
    } finally { await bridge.dispose(); }
  }
  (globalThis as any)[CLEANUP_KEY] = cleanup;

  pi.on("session_start", async (_event, context) => {
    if (ctx) await cleanup();
    else await bridge.dispose();
    ctx = context;
    disposed = false;
    agents.clear();
    reportedErrors.clear();
    bridge = new TreeBridge(byId, observeTree, (error) => reportError(undefined, error));
    if (process.env.PI_SUBAGENT_ID && !process.env.PI_SUBAGENT_ALLOWED) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !SPAWNING_TOOLS.includes(name)));
    }
    // Reload/restart preserves finished conversations, never reattaches dead processes.
    for (const [name, entry] of Object.entries(readNameRegistry(artifactDir(context)))) {
      const loadout = readSubagentLoadout(entry.sessionFile);
      const agent = new Subagent(name, loadout?.agent ?? "subagent", "Saved session", entry.sessionFile, true);
      agent.phase = "completed";
      agent.depth = name.split("/").length - 1;
      agent.activity = "saved session";
      agent.model = loadout?.model ?? undefined;
      agent.thinking = loadout?.thinking ?? undefined;
      if (existsSync(entry.sessionFile)) {
        try {
          const entries = getActiveSessionEntries(entry.sessionFile);
          agent.loadMessages(entries.filter((e: any) => e.type === "message").map((e: any) => e.message));
        } catch (error) { reportError(agent, `Cannot read saved subagent "${name}": ${String(error)}`); }
      }
      agents.set(name, agent);
    }
    for (const agent of agents.values()) agent.parentId = agents.get(agent.name.slice(0, agent.name.lastIndexOf("/")))?.id;
    updateWidget();
    if (context.mode === "tui") interval = setInterval(updateWidget, 1000);
  });
  pi.on("session_shutdown", cleanup);

  function attach(agent: Subagent, context: ExtensionContext) {
    agents.set(agent.name, agent);
    publishChildren();
    bridge.connect(agent);
    agent.on("change", () => { closeDescendantViews(agent); updateWidget(); });
    agent.on("fault", (error) => reportError(agent, error));
    agent.on("notice", (text, level) => {
      if (disposed) return;
      if (level === "error") reportError(agent, text);
      else if (!bridge.hasParent) context.ui.notify(clean(String(text)), level ?? "info");
    });
    agent.on("question", (question) => {
      if (!disposed) sendToChat(agent, { customType: "subagent_question", content: `Subagent "${agent.name}" asks:\n\n${question}\n\nReply with subagent_message({ name: ${JSON.stringify(agent.name)}, message: "…" }).`, display: true });
    });
    agent.onDialog = (record) => {
      if (disposed || !agent.live || bridge.hasParent) return;
      const deadline = record.timeout ? Date.now() + record.timeout : undefined;
      // Parallel children must not replace each other's dialogs in Pi's editor slot.
      dialogQueue = dialogQueue.then(async () => {
        while (opening && !screen && !disposed && agent.live) await new Promise((resolve) => setTimeout(resolve, 20));
        if (disposed || !agent.live || context !== ctx) return;
        if (deadline && Date.now() >= deadline) return;
        dismiss?.();
        dialogActive = true;
        dialogAgent = agent;
        const controller = new AbortController();
        const abort = () => controller.abort();
        agent.once("finished", abort);
        let dialogComponent: ChildDialog | undefined;
        try {
          let response: any = { type: "extension_ui_response", id: record.id };
          const timeout = deadline ? Math.max(1, deadline - Date.now()) : undefined;
          if (context.mode === "tui") {
            response = await context.ui.custom<RpcRecord>((tui, theme, _keys, done) => {
              dialogComponent = new ChildDialog(tui, theme, agent, { ...record, timeout }, done, context);
              cancelDialog = () => dialogComponent?.cancel();
              return guardComponent(dialogComponent, (error) => { dialogComponent?.cancel(); reportError(agent, error); });
            });
          } else {
            cancelDialog = abort;
            const opts = { signal: controller.signal, timeout };
            const cancelled = new Promise<undefined>((resolve) => controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
            if (record.method === "confirm") response.confirmed = await Promise.race([context.ui.confirm(`[${agent.name}] ${record.title}`, record.message ?? "", opts), cancelled]);
            else if (record.method === "select") response.value = await Promise.race([context.ui.select(`[${agent.name}] ${record.title}`, record.options, opts), cancelled]);
            else if (record.method === "editor") response.value = await Promise.race([context.ui.editor(`[${agent.name}] ${record.title}`, record.prefill), cancelled]);
            else response.value = await Promise.race([context.ui.input(`[${agent.name}] ${record.title}`, record.placeholder, opts), cancelled]);
            if ((response.value === undefined && record.method !== "confirm") || controller.signal.aborted) response.cancelled = true;
          }
          if (!disposed && agent.live && context === ctx) agent.rpc?.write(response);
        } catch (error) {
          if (!disposed && context === ctx) {
            reportError(agent, error);
            // A failed modal must also release the child waiting for its response.
            try { if (agent.live) agent.rpc?.write({ type: "extension_ui_response", id: record.id, cancelled: true }); }
            catch (failure) { reportError(agent, failure); }
          }
        }
        finally { dialogComponent?.dispose(); agent.off("finished", abort); cancelDialog = undefined; dialogActive = false; dialogAgent = undefined; }
      }).catch((error) => { if (!disposed) reportError(agent, error); });
    };
    agent.once("finished", () => {
      finishDescendants(agent);
      agent.removeAllListeners("change");
      publishChildren();
      updateWidget();
      if (disposed) return;
      try { registerName(artifactDir(context), agent.name, { sessionFile: agent.sessionFile, sessionId: getSessionId(agent.sessionFile) }); }
      catch (error) { reportError(agent, `Could not update subagent registry: ${String(error)}`); }
      let stats = null;
      try { stats = existsSync(agent.sessionFile) ? summarizeSessionStats(agent.sessionFile) : null; }
      catch (error) { reportError(agent, error); }
      sendToChat(agent, { customType: "subagent_result", content: `Subagent "${agent.name}" ${agent.phase} (${agent.elapsed}s).\n\n${agent.error ? `Error: ${agent.error}\n\n` : ""}${agent.summary}\n\nFollow up with subagent_message({ name: ${JSON.stringify(agent.name)}, message: "…" }).`, display: true,
        details: { name: agent.name, agent: agent.agent, phase: agent.phase, sessionFile: agent.sessionFile, stats, parent: agent.parentId ? byId(agent.parentId)?.name : undefined } });
    });
    updateWidget();
  }

  async function launch(name: string, task: string, loadout: SubagentLoadout, sessionFile: string, context: ExtensionContext, skills?: string, override?: ResolvedModel) {
    if (disposed) throw new Error("Parent session is shutting down.");
    const resolved = override ?? resolveLoadoutModel({ loadout, config: loadSubagentConfig(), catalog: buildModelCatalog(context) });
    if (resolved.error) throw new Error(resolved.error);
    if (resolved.warning) context.ui.notify(resolved.warning, "warning");
    const args = ["--session", sessionFile, "--name", name];
    applySandboxToParts(args, loadout, { artifactDir: artifactDir(context), name, model: resolved.command, thinking: resolved.thinking });
    const control = join(SUBAGENTS_DIR, "control.ts");
    if (!args.includes(control)) args.push("-e", control);
    const env = { ...process.env };
    // Never leak the parent's child identity, wait state, or delegation grant.
    for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_")) delete env[key];
    env.PI_SUBAGENT_ID = randomUUID();
    env.PI_SUBAGENT_NAME = name;
    if (loadout.agent) env.PI_SUBAGENT_AGENT = loadout.agent;
    if (loadout.agentDir) env.PI_CODING_AGENT_DIR = loadout.agentDir;
    // An explicit empty grant distinguishes a leaf child from the unrestricted parent.
    env.PI_SUBAGENT_ALLOWED = loadout.spawnable?.join(",") ?? "";
    registerName(artifactDir(context), name, { sessionFile, sessionId: getSessionId(sessionFile) });
    let rpc: PiRpc;
    try { rpc = (dependencies.createRpc ?? ((args, options) => new PiRpc(args, options)))(args, { cwd: loadout.cwd ?? context.cwd, env }); }
    catch (error) { throw new Error(`Could not start "${name}": ${String(error)}`); }
    const agent = new Subagent(name, loadout.agent ?? "subagent", task, sessionFile, loadout.autoExit, rpc, env.PI_SUBAGENT_ID);
    agent.model = resolved.command ?? undefined;
    agent.thinking = resolved.thinking ?? undefined;
    attach(agent, context);
    try {
      // Handshake ensures listeners are installed before sending the task.
      await rpc.request("get_state");
      const history = await rpc.request("get_messages");
      agent.loadMessages(history?.messages ?? []);
      agent.model = resolved.command ?? agent.model;
      // Read the CHILD's resource catalogue (its cwd/config may differ from ours).
      const commands = skills?.trim() ? (await rpc.request("get_commands"))?.commands ?? [] : [];
      await agent.send(buildTaskWithSkills(task, skills, commands));
      return agent;
    } catch (error) { await agent.fail(error); throw error; }
  }

  async function spawnAgent(params: typeof SubagentParams.static, context: ExtensionContext, manual = false) {
    const definition = discoverAgentDefinitions().find((a) => a.name === params.agent);
    if (!definition) throw new Error(`Unknown or disallowed agent "${params.agent}".`);
    if (definition.disableModelInvocation && !manual) throw new Error(`Agent "${params.agent}" is manual-only. Use /subagent.`);
    if (definition.cli && definition.cli !== "pi") throw new Error("Only Pi RPC agents are supported. Remove cli: claude from this profile.");
    const registry = readNameRegistry(artifactDir(context));
    let name = params.name?.trim() || params.agent;
    if (params.name && (agents.has(name) || registry[name])) throw new Error(`Subagent name "${name}" is already taken. Use subagent_message to follow up.`);
    if (["__proto__", "constructor", "prototype"].includes(name) || /[/\\\x00-\x1f\x7f-\x9f]/.test(name)) throw new Error("Reserved subagent name. Names cannot contain slashes or control characters.");
    if (!params.name) {
      let suffix = 2;
      while (agents.has(name) || registry[name]) name = `${params.agent}-${suffix++}`;
    }
    const resolvedModel = resolveModelForSpawn(params, definition, context);
    const base = definition.cwd && !params.cwd ? getAgentDir() : context.cwd;
    const rawCwd = params.cwd ?? definition.cwd;
    const cwd = rawCwd ? isAbsolute(rawCwd) ? rawCwd : resolve(base, rawCwd) : context.cwd;
    const agentDir = existsSync(join(cwd, ".pi", "agent")) ? join(cwd, ".pi", "agent") : getAgentDir();
    const sessionDir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);
    // A durable empty session also makes startup failures resumable by the same name.
    seedSubagentSessionFile({ mode: definition.sessionMode ?? "standalone", parentSessionFile: context.sessionManager.getSessionFile() ?? undefined, childSessionFile: sessionFile, childCwd: cwd });
    const tools = new Set((definition.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean));
    if (definition.subagentAgents?.length) for (const tool of SPAWNING_TOOLS) tools.add(tool);
    else for (const tool of SPAWNING_TOOLS) tools.delete(tool);
    if (tools.size || definition.tools?.trim()) tools.add("ask_question");
    const identityInSystem = !!definition.systemPromptMode;
    const loadout: SubagentLoadout = { agent: params.agent, toolAllowlist: tools.size ? [...tools].join(",") : null, model: resolvedModel.token, thinking: resolvedModel.thinking,
      identity: identityInSystem ? definition.body ?? null : null, systemPromptMode: definition.systemPromptMode ?? null,
      spawnable: definition.subagentAgents ?? null, autoExit: definition.autoExit ?? true, cwd, agentDir };
    writeSubagentLoadout(sessionFile, loadout);
    const task = `${!identityInSystem && definition.body ? definition.body + "\n\n" : ""}Task:\n\n${params.task}\n\nComplete the task and summarize your result in your final response. Use ask_question if you need a decision.`;
    return launch(name, task, loadout, sessionFile, context, definition.skills, resolvedModel);
  }

  pi.registerTool({ name: "subagent", label: "Subagent", description: "Launch an isolated Pi subagent in the background. Results arrive automatically; do not poll. The user can open it inside the main tab.", parameters: SubagentParams,
    async execute(_id, params, _signal, _update, context) {
      return withErrors(undefined, async () => {
        const agent = await spawnAgent(params, context);
        return { content: [{ type: "text" as const, text: `Started "${agent.name}" (${agent.agent}). Results will arrive automatically. Follow up using subagent_message with this name.` }], details: { name: agent.name, sessionFile: agent.sessionFile } };
      });
    } });

  pi.registerTool({ name: "subagent_message", label: "Message Subagent", description: "Send a message to a live subagent, or resume a finished subagent's saved session with its original profile and tools.", parameters: Type.Object({ name: Type.String(), message: Type.String() }),
    async execute(_id, params, _signal, _update, context) {
      return withErrors(agents.get(params.name), async () => {
        if (!params.message.trim()) throw new Error("Message must not be empty.");
        const existing = agents.get(params.name);
        if (existing?.live) await existing.send(params.message);
        else {
          if (existing?.rpc && !existing.finishedAt) throw new Error("Subagent is still closing. Wait for its result before resuming.");
          const entry = readNameRegistry(artifactDir(context))[params.name];
          if (!entry || !existsSync(entry.sessionFile)) throw new Error(`No saved subagent named "${params.name}".`);
          const loadout = readSubagentLoadout(entry.sessionFile);
          if (!loadout) throw new Error("Missing loadout snapshot; refusing an unrestricted resume.");
          await launch(params.name, params.message, { ...loadout, autoExit: true }, entry.sessionFile, context);
        }
        return { content: [{ type: "text" as const, text: `Message delivered to "${params.name}". Results arrive automatically.` }], details: { name: params.name } };
      });
    } });

  pi.registerTool({ name: "subagents_list", label: "List Subagents", description: "List available profiles and spawned agents. Not needed to poll for results.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, context) {
      return withErrors(undefined, async () => {
        const config = loadSubagentConfig();
        const catalog = buildModelCatalog(context);
        const profiles = discoverAgentDefinitions().filter((a) => !a.disableModelInvocation).map((a) => {
          const resolved = resolveSubagentModel({ agentName: a.name, agentModel: a.model ?? null, agentThinking: a.thinking ?? null, param: null, config, catalog });
          return { name: a.name, description: a.description, model: a.model, tools: a.tools, effectiveModel: resolved.command, modelSource: resolved.source, modelLabel: `${resolved.command ?? "default"} · ${formatModelSource(resolved.source)}` };
        });
        const sessions = orderAgents(Array.from(agents.values())).map((a) => ({ name: a.name, agent: a.agent, phase: a.phase, activity: a.activity, parent: a.parentId ? byId(a.parentId)?.name : undefined }));
        return { content: [{ type: "text" as const, text: JSON.stringify({ profiles, sessions }, null, 2) }], details: { agents: profiles, sessions } };
      });
    } });

  pi.registerCommand("subagents", { description: "Select a subagent and open its in-tab conversation", handler: async (name, context) => {
    ctx = context;
    if (name.trim() && !agents.has(name.trim())) { reportError(undefined, `Unknown subagent: ${name.trim()}`); return; }
    await openView(agents.get(name.trim()));
  } });
  pi.registerShortcut(SUBAGENT_SHORTCUT, { description: "Open subagent conversations", handler: async (context) => { ctx = context; await openView(); } });
  pi.registerCommand("subagent", { description: "Launch a profile: /subagent <agent> <task>", handler: async (args, context) => {
    const [agent, ...rest] = args.trim().split(/\s+/);
    if (!agent) { context.ui.notify("Usage: /subagent <agent> <task>", "warning"); return; }
    try { await spawnAgent({ agent, task: rest.join(" ") || "Introduce yourself and wait for instructions." }, context, true); }
    catch (error) { reportError(undefined, error); }
  } });
  pi.registerCommand("subagent-stop", { description: "Stop a subagent: /subagent-stop <name>", handler: async (name, context) => {
    const agent = agents.get(name.trim());
    if (!agent?.live) { reportError(agent, "No live subagent with that name."); return; }
    try { await agent.stop(); } catch (error) { reportError(agent, error); }
  } });

  for (const kind of ["subagent_result", "subagent_question", "subagent_error"]) pi.registerMessageRenderer(kind, (message, options, theme) => {
    const content = typeof message.content === "string" ? clean(message.content) : "";
    const lines = options.expanded ? content : content.split("\n").slice(0, 6).join("\n");
    return new Text(theme.fg(kind === "subagent_error" ? "error" : "accent", kind === "subagent_result" ? "Subagent result\n" : kind === "subagent_error" ? "Subagent error\n" : "Subagent question\n") + lines, 1, 1);
  });

  registerModelCommand(pi);
}

type ModelSelectionContext = ExtensionContext & {
  mode?: string;
  thinkingLevel?: string;
  scopedModels?: readonly { model: ModelPickerModel }[];
};

function buildModelCatalog(ctx: ModelSelectionContext | undefined): ModelCatalog {
  const available = (ctx?.modelRegistry?.getAvailable() ?? []).map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    supportedThinking: supportedThinkingLevels(model),
  }));
  return {
    parentModel: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    parentThinking: ctx?.thinkingLevel ?? latestPi?.getThinkingLevel?.() ?? null,
    parentSupportedThinking: ctx?.model ? supportedThinkingLevels(ctx.model) : undefined,
    available,
  };
}

/**
 * Resolve a sub-agent's model: the per-agent config pick, then the spawn
 * parameter, then the config default, then the agent frontmatter. Throws when
 * the resolved model is unusable and `models.fallback` is `fail`.
 */
function resolveModelForSpawn(
  params: typeof SubagentParams.static,
  agentDefs: AgentDefaults | null,
  ctx: ExtensionContext,
): ResolvedModel {
  const resolved = resolveSubagentModel({
    param: params.model ?? null,
    agentName: params.agent ?? null,
    agentModel: agentDefs?.model ?? null,
    agentThinking: agentDefs?.thinking ?? null,
    config: loadSubagentConfig(),
    catalog: buildModelCatalog(ctx),
  });

  if (resolved.error) throw new Error(resolved.error);
  if (resolved.warning) ctx.ui.notify(resolved.warning, "warning");
  return resolved;
}

/** Sentinel value the picker returns for "reset to the agent's own model". */
const RESET_MODEL_CHOICE = "reset-to-the-agents-own-model";

/** Sentinel value the thinking step returns for "reset to inherited/default". */
const RESET_THINKING_CHOICE = "reset-to-inherited-thinking";

/** Sentinel value the thinking step returns for "leave thinking unchanged". */
const LEAVE_THINKING_CHOICE = "leave-thinking-unchanged";

/** Thinking levels a model token supports; `inherit` follows the parent model. */
function supportedThinkingForToken(
  token: string | null,
  catalog: ModelCatalog,
): readonly ThinkingLevelName[] {
  if (token === INHERIT_TOKEN) {
    return catalog.parentSupportedThinking ?? THINKING_LEVELS;
  }
  if (token) {
    const match = findAvailableModel(token, catalog.available);
    if (match?.supportedThinking) return match.supportedThinking;
  }
  return THINKING_LEVELS;
}

/** Build the thinking step rows, flagging the target's current effective level. */
function buildThinkingItems(
  levels: readonly ThinkingLevelName[],
  currentThinking: ThinkingLevelName | null,
): ModelPickerItem[] {
  const items: ModelPickerItem[] = [
    {
      value: LEAVE_THINKING_CHOICE,
      label: "leave thinking unchanged",
      searchText: "leave thinking unchanged",
    },
    {
      value: RESET_THINKING_CHOICE,
      label: "reset to inherited/default",
      searchText: "reset to inherited default thinking",
    },
    ...levels.map((level) => ({ value: level, label: level, searchText: level })),
  ];

  const currentIndex =
    currentThinking === null
      ? items.findIndex((item) => item.value === RESET_THINKING_CHOICE)
      : items.findIndex((item) => item.value === currentThinking);
  if (currentIndex >= 0) items[currentIndex] = { ...items[currentIndex], current: true };
  return items;
}

/** Models offered by /subagent-model: the session's scoped set, else the credentialed catalogue. */
function collectPickableModels(ctx: ModelSelectionContext): ModelPickerModel[] {
  const scopedModels = ctx.scopedModels ?? [];
  if (scopedModels.length > 0) {
    return scopedModels.map((entry) => entry.model);
  }

  const registry = ctx.modelRegistry;
  return (registry?.getAvailable() ?? []).filter(
    (model) => !registry?.hasConfiguredAuth || registry.hasConfiguredAuth(model),
  );
}

/** Show the scrollable picker in TUI mode, falling back to the plain selector elsewhere. */
async function pickModelChoice(
  ctx: ModelSelectionContext,
  title: string,
  items: readonly ModelPickerItem[],
  signal?: AbortSignal,
  onError?: (error: unknown) => void,
): Promise<string | undefined> {
  if (ctx.mode !== undefined ? ctx.mode !== "tui" : !ctx.hasUI) {
    const chosenLabel = await ctx.ui.select(`${title}:`, items.map((item) => item.label), { signal });
    return items.find((item) => item.label === chosenLabel)?.value;
  }

  let unsubscribe: (() => void) | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    return await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
      let completed = false;
      const finish = (value: string | undefined) => { if (completed) return; completed = true; done(value); };
      const abort = () => finish(undefined);
      if (signal?.aborted) queueMicrotask(abort);
      else signal?.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal?.removeEventListener("abort", abort);
      const component = new ModelPickerComponent(theme, { title, items }, finish);
      // Consume Ctrl+C before it can reach Pi's interrupt/exit handlers, even
      // when closing the dialog restores focus to the main editor immediately.
      unsubscribe = ctx.ui.onTerminalInput?.((data) => {
        if (matchesKey(data, Key.ctrl("c"))) {
          finish(undefined);
          return { consume: true };
        }
      });
      const handleInput = component.handleInput.bind(component);
      component.handleInput = (data: string) => {
        try { handleInput(data); tui.requestRender(); }
        catch (error) { finish(undefined); if (onError) onError(error); else throw error; }
      };
      return onError ? guardComponent(component, (error) => { finish(undefined); onError(error); }) : component;
    });
  } finally {
    removeAbort?.();
    unsubscribe?.();
  }
}

function registerModelCommand(pi: ExtensionAPI) {
  pi.registerCommand("subagent-model", {
    description: "Choose which model a sub-agent runs on (writes the subagent config)",
    handler: async (_args, ctx) => {
      const registry = ctx.modelRegistry;
      if (!registry?.getAvailable) {
        ctx.ui.notify("This pi build does not expose the model registry.", "error");
        return;
      }

      const allLabel = "all agents (config default)";
      const agentNames = discoverAgentDefinitions()
        .filter((agent) => !agent.disableModelInvocation)
        .map((agent) => agent.name)
        .sort();

      const target = await pickModelChoice(ctx, "Set the sub-agent model for", [allLabel, ...agentNames].map((name) => ({
        value: name,
        label: name,
        searchText: name,
      })));
      if (!target) return;

      const agentName = target === allLabel ? null : target;
      const config = loadSubagentConfig();
      const configuredEntry = agentName ? config.models?.agents[agentName] : undefined;
      const currentValue = configuredEntry?.model ?? config.models?.default ?? null;

      const items = buildModelPickerItems({
        models: collectPickableModels(ctx),
        currentValue,
        leadingItems: [
          {
            value: INHERIT_TOKEN,
            label: "inherit — follow this session's model",
            searchText: "inherit follow this session model",
          },
          {
            value: RESET_MODEL_CHOICE,
            label: "reset to the agent's own model",
            searchText: "reset to the agent own model",
          },
        ],
      });

      const choice = await pickModelChoice(ctx, `${target} — model`, items);
      if (!choice) return;

      const value = choice === RESET_MODEL_CHOICE ? null : choice;
      const catalog = buildModelCatalog(ctx);
      const levels = supportedThinkingForToken(
        choice === RESET_MODEL_CHOICE ? currentValue : choice,
        catalog,
      );
      const nonReasoning = levels.length === 1 && levels[0] === "off";
      const currentThinking = configuredEntry?.thinking ?? config.models?.thinking ?? null;
      const thinkingItems = buildThinkingItems(levels, currentThinking);
      const thinkingTitle = nonReasoning
        ? `${target} — thinking (this model does not support thinking levels, only "off")`
        : `${target} — thinking`;

      const thinkingChoice = await pickModelChoice(ctx, thinkingTitle, thinkingItems);
      if (!thinkingChoice) return;

      const thinking: ThinkingLevelName | null | undefined =
        thinkingChoice === LEAVE_THINKING_CHOICE
          ? undefined
          : thinkingChoice === RESET_THINKING_CHOICE
            ? null
            : (thinkingChoice as ThinkingLevelName);

      try {
        const { path, changed } = writeModelSelection({ agentName, model: value, thinking });
        if (!changed) {
          ctx.ui.notify(`Nothing to clear for ${target} — no override is set.`, "info");
          return;
        }
        const modelLabel = value === null ? "the agent default" : value;
        const thinkingLabel =
          thinking === undefined
            ? currentThinking ?? "unchanged"
            : thinking ?? "inherited/default";
        ctx.ui.notify(
          `Set ${target}: model ${modelLabel}, thinking ${thinkingLabel}. Written to ${path}.`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not update the sub-agent config: ${message}`, "error");
      }
    },
  });

}

export const __test__ = { buildModelCatalog, collectPickableModels, pickModelChoice, applySandboxToParts };
