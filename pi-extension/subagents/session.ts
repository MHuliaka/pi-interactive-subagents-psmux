import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "standalone" | "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
  const branch = getActiveSessionEntries(parentSessionFile);
  const dispatch = branch.findLastIndex((e) => e.type === "message" && (e as MessageEntry).message?.role === "user");
  return (dispatch >= 0 ? branch.slice(0, dispatch) : branch).map((e) => JSON.stringify(e));
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile?: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  if (params.mode !== "standalone" && !params.parentSessionFile) throw new Error("Fork/lineage-only sessions require a parent session file.");
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.mode === "standalone" ? undefined : params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile!) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

/**
 * A snapshot of everything needed to reconstruct a subagent's sandbox when its
 * session is later resumed via `subagent_message({ name })`.
 *
 * Written next to the session file as `<sessionFile>.loadout.json` at spawn
 * time. Resume replays this exact snapshot so the reincarnated process gets the
 * same `--no-extensions` + `--tools` restriction, model, identity, spawn
 * whitelist, cwd, and config dir it originally ran with — instead of falling
 * back to pi's default (all global extensions + full toolset). Storing the
 * resolved loadout (rather than re-deriving from the agent `.md` by name) keeps
 * resume faithful even if the agent definition is later edited, moved, or
 * deleted.
 */
export interface SubagentLoadout {
  /** Agent profile name (for PI_SUBAGENT_AGENT); null for agentless spawns. */
  agent: string | null;
  /** The `--tools` allowlist string, or null when the spawn was unrestricted. */
  toolAllowlist: string | null;
  /**
   * Model token: a literal `provider/modelId`, the inherit token, or null to
   * use the session default. The inherit token is kept unresolved here so a
   * resume can re-resolve it against the parent session.
   */
  model: string | null;
  /** Thinking level appended to the model as `model:level`, or null. */
  thinking: string | null;
  /** How the identity text was applied: append/replace, or null. */
  systemPromptMode: "append" | "replace" | null;
  /** The system-prompt/identity text, only when it lived in the system prompt. */
  identity: string | null;
  /** Agents this subagent was allowed to spawn (for PI_SUBAGENT_ALLOWED). */
  spawnable: string[] | null;
  /** Whether the agent auto-exits (informational; resume forces autonomous). */
  autoExit: boolean;
  /** Working directory the subagent ran in, or null. */
  cwd: string | null;
  /** PI_CODING_AGENT_DIR the subagent resolved config/extensions from, or null. */
  agentDir: string | null;
}

/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

/** Persist a subagent's resolved sandbox loadout beside its session file. */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
}

/** Read a subagent's loadout snapshot, or null if absent/unparseable. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const p = loadoutSidecarPath(sessionFile);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const nullableStrings = ["agent", "toolAllowlist", "model", "thinking", "identity", "cwd", "agentDir"];
    if (nullableStrings.some((key) => parsed[key] !== null && typeof parsed[key] !== "string")) return null;
    if (![null, "append", "replace"].includes(parsed.systemPromptMode) || typeof parsed.autoExit !== "boolean") return null;
    if (parsed.spawnable !== null && (!Array.isArray(parsed.spawnable) || parsed.spawnable.some((name: unknown) => typeof name !== "string"))) return null;
    return parsed as SubagentLoadout;
  } catch {
    return null;
  }
}

// ── Name registry ────────────────────────────────────────────────────────────
// Each spawner session (the top-level pi session, or a worker that spawns its
// own children) gets a registry mapping a subagent's display name to the
// session file it ran in. Names are unique per spawner session and persist on
// disk, so `subagent_message({ name })` can steer a running subagent or resume
// a finished one by the same handle — even across a pi restart. The registry
// lives in the spawner's own artifact dir, which is directly addressable from
// the spawner's session id (no sessions-tree scan, so resume stays fast).

export interface NameRegistryEntry {
  /** Absolute path to the subagent's session .jsonl file. */
  sessionFile: string;
  /** Canonical session header id (kept for display/lineage). */
  sessionId: string | null;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

/** Path of the name registry for a given spawner session's artifact dir. */
export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

/** Read a spawner session's name registry, or {} if absent/corrupt. */
export function readNameRegistry(artifactDir: string): NameRegistry {
  try {
    const p = nameRegistryPath(artifactDir);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const registry: NameRegistry = Object.create(null);
    for (const [name, value] of Object.entries(parsed)) {
      if (["__proto__", "constructor", "prototype"].includes(name)) continue;
      if (value && typeof value === "object" && typeof (value as NameRegistryEntry).sessionFile === "string") registry[name] = value as NameRegistryEntry;
    }
    return registry;
  } catch {
    return {};
  }
}

/**
 * Register (or overwrite) a name → session mapping for a spawner session.
 * Writes atomically (temp file + rename) so a concurrent reader never sees a
 * partial registry.
 */
export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  if (["__proto__", "constructor", "prototype"].includes(name)) throw new Error("Reserved subagent name.");
  mkdirSync(artifactDir, { recursive: true });
  const registry = readNameRegistry(artifactDir);
  registry[name] = entry;
  const p = nameRegistryPath(artifactDir);
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  renameSync(tmp, p);
}

function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function getSessionId(sessionFile: string): string | null {
  return readHeaderId(sessionFile);
}

function readHeaderId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  const entries: SessionEntry[] = [];
  const pending = lines.slice(afterLine);
  for (const [index, line] of pending.entries()) {
    try { entries.push(JSON.parse(line) as SessionEntry); }
    catch (error) {
      // A crash can leave one partial final record; earlier corruption is not hidden.
      if (index !== pending.length - 1) throw error;
    }
  }
  return entries;
}


export function getActiveSessionEntries(path: string): SessionEntry[] {
  const entries = getNewEntries(path, 0).filter((e) => e.type !== "session");
  const byId = new Map(entries.map((e) => [e.id, e]));
  const branch: SessionEntry[] = [];
  let leaf = entries.at(-1);
  const seen = new Set<string>();
  while (leaf?.id && !seen.has(leaf.id)) {
    seen.add(leaf.id);
    branch.unshift(leaf);
    leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
  }
  return branch.length ? branch : entries;
}

const readEntries = (path: string) => getNewEntries(path, 0);

export interface SessionStats {
  model: string | null;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
}

/**
 * Parse a completed subagent session JSONL into aggregate stats for display:
 * model, tool-call count, cumulative token usage + cost, and current context
 * size. Cumulative usage fields are summed across every assistant turn; the
 * context size is taken from the last assistant turn's `totalTokens` (the live
 * context window occupancy). Returns null if the file can't be read.
 */
export function summarizeSessionStats(sessionFile: string): SessionStats | null {
  let entries: SessionEntry[];
  try {
    entries = readEntries(sessionFile);
  } catch {
    return null;
  }

  const stats: SessionStats = {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const modelId = (entry as { modelId?: unknown }).modelId;
      if (typeof modelId === "string" && modelId) stats.model = modelId;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg.role !== "assistant") continue;

    const model = (msg as { model?: unknown }).model;
    if (typeof model === "string" && model) stats.model = model;

    for (const block of msg.content) {
      if (block.type === "toolCall") stats.toolCount++;
    }

    const usage = (msg as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === "object") {
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      stats.inputTokens += num(usage.input);
      stats.outputTokens += num(usage.output);
      stats.cacheReadTokens += num(usage.cacheRead);
      stats.cacheWriteTokens += num(usage.cacheWrite);
      const total = num(usage.totalTokens);
      if (total > 0) stats.contextTokens = total;
      const cost = usage.cost;
      if (cost && typeof cost === "object") stats.cost += num((cost as Record<string, unknown>).total);
    }
  }

  return stats;
}
