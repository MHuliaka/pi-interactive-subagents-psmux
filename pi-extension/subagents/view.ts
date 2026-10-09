import { CustomEditor, getSelectListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Loader, ScrollView, matchesKey, truncateToWidth, visibleWidth, type Component, type EditorComponent, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Subagent } from "./runtime.ts";
import { nativePresentation, nativeKeybindings, type NativePresentation } from "./native-context.ts";
import { NativeTranscript } from "./native-transcript.ts";
import { SUBAGENT_SHORTCUT } from "./shortcuts.ts";

const BLUE = "\x1b[38;2;77;163;255m";
const RESET = "\x1b[0m";
export const clean = (value: string) => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export function blueBox(title: string, content: string[], width: number): string[] {
  if (width < 2) return Array(content.length + 2).fill(width === 1 ? `${BLUE}│${RESET}` : "");
  const inner = width - 2;
  const heading = truncateToWidth(`─ ${clean(title)} `, inner, "");
  return [`${BLUE}╭${heading}${"─".repeat(Math.max(0, inner - visibleWidth(heading)))}╮${RESET}`, ...content.map((line) => {
    const text = truncateToWidth(line, inner, "");
    return `${BLUE}│${RESET}${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}${BLUE}│${RESET}`;
  }), `${BLUE}╰${"─".repeat(inner)}╯${RESET}`];
}
export function orderAgents(agents: Subagent[]): Subagent[] {
  const ids = new Set(agents.map((a) => a.id));
  const children = new Map<string | undefined, Subagent[]>();
  for (const agent of agents) {
    const parent = agent.parentId && ids.has(agent.parentId) ? agent.parentId : undefined;
    const list = children.get(parent) ?? [];
    list.push(agent); children.set(parent, list);
  }
  const result: Subagent[] = [], seen = new Set<string>();
  const visit = (agent: Subagent) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id); result.push(agent);
    for (const child of children.get(agent.id) ?? []) visit(child);
  };
  for (const root of children.get(undefined) ?? []) visit(root);
  for (const agent of agents) visit(agent);
  return result;
}
/** Align existing row fields without changing arrows, nesting or separators. */
export function formatAgentRows(agents: Subagent[], width: number): string[] {
  if (!agents.length) return [];
  const cells = agents.map((a) => [
    ` ${"  ".repeat(a.depth)}${a.depth ? "↳" : "›"} ${clean(a.name)}`,
    `(${clean(a.agent)})`, a.phase, clean(a.activity), `${a.elapsed}s`,
  ]);
  const sizes = Array.from({ length: 5 }, (_, column) => Math.max(...cells.map((row) => visibleWidth(row[column]))));
  const separators = [" ", " · ", " · ", " · "];
  let overflow = sizes.reduce((sum, size) => sum + size, 0) + 10 - Math.max(0, width);
  const prefixWidth = Math.max(...agents.map((a) => 3 + a.depth * 2));
  // Shorten names/activity before sacrificing status or elapsed time. Preserve
  // hierarchy prefixes whenever the terminal can fit the five-column layout.
  for (const [column, minimum] of [[0, prefixWidth + 6], [3, 6], [1, 4], [0, prefixWidth + 1], [2, 1], [4, 1]]) {
    if (overflow <= 0) break;
    const reduction = Math.min(overflow, Math.max(0, sizes[column] - minimum));
    sizes[column] -= reduction; overflow -= reduction;
  }
  return cells.map((row) => {
    const columns = row.map((cell, column) => {
      const text = column === 1 && visibleWidth(cell) > sizes[column]
        ? `(${truncateToWidth(cell.slice(1, -1), Math.max(0, sizes[column] - 2))})`
        : truncateToWidth(cell, sizes[column], column === 0 ? "..." : "…");
      return text + " ".repeat(Math.max(0, sizes[column] - visibleWidth(text)));
    });
    return truncateToWidth(columns.map((column, i) => column + (separators[i] ?? "")).join(""), Math.max(0, width), "");
  });
}
export function guardComponent<T extends Component>(component: T, onError: (error: unknown) => void): T {
  for (const method of ["render", "handleInput", "handleMouse", "invalidate"] as const) {
    const original = (component as any)[method];
    if (typeof original !== "function") continue;
    (component as any)[method] = (...args: any[]) => {
      try { return original.apply(component, args); }
      catch (error) { onError(error); return method === "render" ? [] : undefined; }
    };
  }
  return component;
}

/** The only custom visual treatment: blue subagent information/navigation. */
export class SubagentWidget implements Component {
  private shown: Subagent[] = [];
  constructor(private readonly agents: () => Subagent[], private readonly open: (agent?: Subagent) => void, private readonly onError: (error: unknown) => void = () => {}) {}
  invalidate() {}
  render(width: number) {
    try {
      const agents = orderAgents(this.agents()).filter((a) => a.live);
      this.shown = agents.slice(-5);
      if (!agents.length) return [];
      const rows = formatAgentRows(this.shown, Math.max(0, width - 2));
      return [...blueBox(`Subagents · ${agents.length} active`, rows, width), ""];
    } catch (error) { this.onError(error); return []; }
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "click" || event.button !== "left") return;
    try { this.open(this.shown[event.y - 1]); } catch (error) { this.onError(error); }
    return { handled: true, render: true };
  }
}

/** Native Pi transcript/editor/loader, hosted in the existing main TUI. */
export class SubagentScreen implements Component {
  focused = false;
  private readonly input: EditorComponent & { focused?: boolean; disableSubmit?: boolean };
  private readonly transcript: NativeTranscript;
  private readonly history: ScrollView;
  private closed = false;
  private disposed = false;
  private sending = false;
  private status = "";
  private loader?: Loader;
  private loaderMessage = "";
  private returnRow = 3;
  private historyTop = 5;
  private readonly requestRender = () => {
    if (this.closed || this.disposed) return;
    try { this.tui.requestRender(); } catch (error) { this.fail(error); }
  };
  private readonly onChange = () => { try { this.syncLoader(); this.requestRender(); } catch (error) { this.fail(error); } };
  private readonly onSettled = () => this.close();

  constructor(private readonly tui: TUI, private readonly theme: Theme, readonly agent: Subagent, private readonly done: () => void,
    private readonly presentation: NativePresentation = nativePresentation(), private readonly keys: KeybindingsManager = nativeKeybindings(), cwd = process.cwd()) {
    const editorTheme = { borderColor: (text: string) => theme.fg("border", text), selectList: getSelectListTheme() };
    const factory = presentation.editorFactory?.();
    this.input = factory ? factory(tui, editorTheme, keys) : new CustomEditor(tui, editorTheme, keys);
    this.transcript = new NativeTranscript(agent, { requestRender: this.requestRender } as TUI, presentation, cwd);
    this.history = new ScrollView(this.transcript, { follow: "end", scrollbar: "hidden", overscroll: "contain" });
    if (this.input instanceof CustomEditor) {
      this.input.onAction("app.tools.expand", () => this.transcript.toggleTools());
      this.input.onAction("app.thinking.toggle", () => this.transcript.toggleThinking());
    }
    this.input.setText(agent.draft);
    this.input.onSubmit = (message) => { void this.submit(message).catch((error) => this.fail(error)); };
    agent.on("change", this.onChange); agent.on("settled", this.onSettled);
    this.syncLoader();
  }
  private draft() { return this.input.getExpandedText?.() ?? this.input.getText(); }
  private syncLoader() {
    const busy = !this.closed && !this.disposed && this.agent.live && (["starting", "running"].includes(this.agent.phase) || (this.agent.phase === "waiting" && this.agent.activity === "awaiting children"));
    if (!busy) { this.loader?.stop(); this.loader = undefined; this.loaderMessage = ""; return; }
    const activity = this.agent.activity;
    const message = this.agent.phase === "waiting" ? "Waiting for child agents…" : this.agent.phase === "starting" ? "Starting agent…"
      : activity === "thinking" ? "Thinking…" : activity === "streaming" ? "Generating response…" : activity === "compacting" ? "Compacting…"
      : activity.startsWith("retry ") ? `Retrying (${activity})…` : ["working", "starting"].includes(activity) ? "Working…" : `Running ${clean(activity)}…`;
    if (!this.loader) {
      const paint = (color: "accent" | "muted") => (text: string) => { try { return this.theme.fg(color, text); } catch (error) { this.fail(error); return ""; } };
      this.loaderMessage = message;
      this.loader = new Loader({ requestRender: this.requestRender } as TUI, paint("accent"), paint("muted"), message, this.presentation.workingIndicator());
      if (this.closed || this.disposed) { this.loader.stop(); this.loader = undefined; }
    } else if (message !== this.loaderMessage) { this.loaderMessage = message; this.loader.setMessage(message); }
  }
  private async submit(message: string) {
    if (this.closed || this.sending || !message.trim()) return;
    if (message.trim() === "/exit") { void this.agent.stop().catch((error) => this.fail(error)); this.close(); return; }
    if (!this.agent.live) { this.input.setText(message); this.status = "Finished session. Use subagent_message to resume it."; this.requestRender(); return; }
    this.sending = true; this.input.disableSubmit = true; this.status = "Sending…";
    try { await this.agent.send(message); this.input.addToHistory?.(message); this.agent.draft = this.draft(); this.status = ""; this.history.scrollToEnd(); }
    catch (error) { const draft = this.draft(); this.input.setText(draft ? `${message}\n${draft}` : message); this.agent.draft = this.draft(); this.fail(error); }
    finally { this.sending = false; this.input.disableSubmit = false; this.requestRender(); }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.agent.draft = this.draft(); } finally { try { this.dispose(); } finally { this.done(); } }
  }
  private fail(error: unknown) {
    let detail = String(error);
    try { this.close(); } catch (failure) { detail += ` (closing view: ${String(failure)})`; }
    this.agent.emit("fault", `Subagent view: ${detail}`);
  }
  handleInput(data: string) {
    try {
      if (this.closed) return;
      if (matchesKey(data, "escape") || matchesKey(data, SUBAGENT_SHORTCUT)) this.close();
      else if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) { void this.agent.stop().catch((error) => this.fail(error)); this.close(); }
      else if (matchesKey(data, "pageUp")) this.history.scrollBy(-this.history.viewportHeight);
      else if (matchesKey(data, "pageDown")) this.history.scrollBy(this.history.viewportHeight);
      else if (matchesKey(data, "ctrl+home")) this.history.scrollToStart();
      else if (matchesKey(data, "ctrl+end")) this.history.scrollToEnd();
      else this.input.handleInput(data);
      this.requestRender();
    } catch (error) { this.fail(error); }
  }
  handleMouse(event: TuiMouseEvent) {
    try {
      if (event.type === "click" && event.button === "left" && event.y === this.returnRow) { this.close(); return { handled: true, render: true }; }
      if (event.type === "wheel") { this.history.scrollBy(event.wheelDelta ?? 0); return { handled: true, render: true }; }
      if (event.y >= this.historyTop && event.y < this.historyTop + this.history.viewportHeight) {
        const result = this.transcript.handleMouse({ ...event, y: event.y - this.historyTop + this.history.scrollTop });
        if (result?.handled) this.requestRender();
        return result;
      }
    } catch (error) { this.fail(error); return { handled: true, render: true }; }
  }
  render(width: number) {
    try {
      this.syncLoader();
      const height = Math.max(1, this.tui.terminal.rows);
      if (width < 4 || height < 10) return Array.from({ length: height }, (_, i) => truncateToWidth(i === 0 ? "Esc: Return to main agent" : "", width));
      this.input.focused = this.focused;
      const info = blueBox(`${clean(this.agent.name)} (${clean(this.agent.agent)})`, [
        ` ${this.agent.phase} · ${clean(this.agent.activity)} · ${this.agent.rpc ? `${this.agent.elapsed}s` : "saved"}${this.status ? ` · ${clean(this.status)}` : ""}`,
        ` Model: ${clean(this.agent.model ?? "default")}${this.agent.thinking ? ` · ${clean(this.agent.thinking)}` : ""}`,
        " ← Return to main agent [Esc] · Stop [Ctrl+C / Ctrl+D]",
      ], width);
      this.returnRow = info.length - 2; this.historyTop = info.length;
      const input = this.input.render(width).slice(0, Math.max(3, height - info.length - 2));
      const progress = this.loader?.render(width).slice(0, 2) ?? [];
      const lines = this.history.render(width);
      const viewport = Math.max(1, height - info.length - input.length - progress.length);
      this.history.updateLayout(lines.length, viewport, this.requestRender);
      const visible = lines.slice(this.history.scrollTop, this.history.scrollTop + viewport);
      while (visible.length < viewport) visible.push("");
      return [...info, ...visible, ...progress, ...input].slice(0, height);
    } catch (error) { this.fail(error); return []; }
  }
  invalidate() { try { this.transcript.invalidate(); this.history.invalidate(); this.input.invalidate(); this.loader?.invalidate(); } catch (error) { this.fail(error); } }
  dispose() {
    this.disposed = true; this.loader?.stop(); this.loader = undefined;
    (this.input as any).dispose?.();
    this.agent.off("change", this.onChange); this.agent.off("settled", this.onSettled);
  }
}
