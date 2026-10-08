import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Markdown, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Subagent, type ToolActivity } from "./runtime.ts";
import { SUBAGENT_SHORTCUT, SUBAGENT_SHORTCUT_HINT } from "./shortcuts.ts";

const BLUE = "\x1b[38;2;77;163;255m";
const RESET = "\x1b[0m";
// Never allow child output to inject terminal control sequences.
export const clean = (value: string) => value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

export function blueBox(title: string, content: string[], width: number): string[] {
  if (width < 2) return Array(content.length + 2).fill(width === 1 ? `${BLUE}│${RESET}` : "");
  const inner = width - 2;
  const heading = truncateToWidth(`─ ${clean(title)} `, inner, "");
  const top = `${BLUE}╭${heading}${"─".repeat(Math.max(0, inner - visibleWidth(heading)))}╮${RESET}`;
  return [top, ...content.map((line) => {
    const text = truncateToWidth(line, inner, "");
    return `${BLUE}│${RESET}${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}${BLUE}│${RESET}`;
  }), `${BLUE}╰${"─".repeat(inner)}╯${RESET}`];
}

/** Bounded widget: all agents remain accessible through the scrollable selector. */
export class SubagentWidget implements Component {
  private shown: Subagent[] = [];
  constructor(private readonly agents: () => Subagent[], private readonly open: (agent?: Subagent) => void) {}
  invalidate() {}
  render(width: number) {
    const agents = this.agents();
    this.shown = agents.slice(-5);
    const count = agents.filter((a) => a.live).length;
    const rows = this.shown.map((a) => truncateToWidth(` › ${clean(a.name)} (${clean(a.agent)}) · ${a.phase} · ${clean(a.activity)} · ${a.rpc ? `${a.elapsed}s` : "saved"}`, Math.max(0, width - 2)));
    rows.push(` /subagents · ${SUBAGENT_SHORTCUT_HINT} · ${agents.length} total${agents.length > 5 ? " (last 5 shown)" : ""}`);
    return blueBox(`Subagents · ${count} running`, rows, width);
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "click" && event.button === "left") {
      const agent = this.shown[event.y - 1];
      this.open(agent);
      return { handled: true, render: true };
    }
    return undefined;
  }
}

/** Covers the terminal without switching the underlying parent session. */
export class SubagentScreen implements Component {
  focused = false;
  private readonly input: Editor;
  private closed = false;
  private sending = false;
  private status = "";
  private scroll = Infinity;
  private viewportHeight = 1;
  private returnRow = 0;
  private cache?: { width: number; revision: number; lines: string[] };
  private readonly onChange = () => this.tui.requestRender();
  private readonly onSettled = () => this.close();

  constructor(private readonly tui: TUI, private readonly theme: Theme, readonly agent: Subagent, private readonly done: () => void) {
    const fg = (color: "accent" | "muted") => (text: string) => theme.fg(color, text);
    this.input = new Editor(tui, { borderColor: (text) => theme.fg("border", text), selectList: {
      selectedPrefix: fg("accent"), selectedText: fg("accent"), description: fg("muted"), scrollInfo: fg("muted"), noMatch: fg("muted"),
    } });
    this.input.setText(agent.draft);
    agent.on("change", this.onChange);
    agent.on("settled", this.onSettled);
    this.input.onSubmit = (message) => { void this.submit(message); };
  }

  private async submit(message: string) {
    if (this.closed || this.sending || !message.trim()) return;
    if (message.trim() === "/exit") { void this.agent.stop(); this.close(); return; }
    if (!this.agent.live) { this.input.setText(message); this.status = "Finished session. Use subagent_message to resume it."; this.onChange(); return; }
    this.sending = true;
    this.input.disableSubmit = true;
    this.status = "Sending…";
    try {
      await this.agent.send(message);
      this.input.addToHistory(message);
      this.agent.draft = this.input.getExpandedText();
      this.status = "Message delivered";
      this.scroll = Infinity;
    } catch (error) {
      this.status = String(error);
      const draft = this.input.getExpandedText();
      this.input.setText(draft ? `${message}\n${draft}` : message);
      this.agent.draft = this.input.getExpandedText();
    }
    finally { this.sending = false; this.input.disableSubmit = false; if (!this.closed) this.onChange(); }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.agent.draft = this.input.getExpandedText();
    this.dispose();
    this.done();
  }

  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, "escape") || matchesKey(data, SUBAGENT_SHORTCUT)) this.close();
    else if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) { void this.agent.stop(); this.close(); }
    else if (matchesKey(data, "pageUp")) this.scrollBy(-this.viewportHeight);
    else if (matchesKey(data, "pageDown")) this.scrollBy(this.viewportHeight);
    else if (matchesKey(data, "ctrl+home")) this.scroll = 0;
    else if (matchesKey(data, "ctrl+end")) this.scroll = Infinity;
    else this.input.handleInput(data);
    this.onChange();
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel") { this.scrollBy(event.wheelDelta ?? 0); return { handled: true, render: true }; }
    if (event.type === "click" && event.button === "left" && event.y === this.returnRow) {
      this.close();
      return { handled: true, render: true };
    }
    return undefined;
  }

  private scrollBy(delta: number) {
    if (!Number.isFinite(this.scroll)) this.scroll = Math.max(0, (this.cache?.lines.length ?? 0) - this.viewportHeight);
    this.scroll = Math.max(0, this.scroll + delta);
  }

  private renderTool(tool: ToolActivity, width: number): string[] {
    const color = tool.state === "failed" ? "error" : tool.state === "completed" ? "success" : "warning";
    const label = `${tool.state === "running" ? "…" : tool.state === "failed" ? "✗" : "✓"} ${tool.name}`;
    const args = clean(JSON.stringify(tool.args, null, 2) ?? "");
    const result = tool.result?.content?.map((b: any) => b.type === "text" ? b.text : `[${b.type}]`).join("\n") ?? "";
    const details = tool.result?.details ? clean(JSON.stringify(tool.result.details, null, 2)) : "";
    return [this.theme.fg(color, truncateToWidth(label, width)),
      ...new Text(args, 0, 0).render(width),
      ...new Text(clean(result), 0, 0).render(width),
      ...(details ? new Text(details, 0, 0).render(width) : []), ""];
  }

  private transcript(width: number) {
    if (this.cache?.width === width && this.cache.revision === this.agent.revision) return this.cache.lines;
    const lines: string[] = [];
    const renderedTools = new Set<string>();
    for (const message of this.agent.messages) {
      const label = message.role === "user" ? "You" : message.role === "assistant" ? this.agent.name : message.customType ?? message.role ?? "Message";
      lines.push(this.theme.fg(message.role === "user" ? "accent" : "muted", clean(label)));
      const rawContent = message.role === "bashExecution" ? `${message.command}\n${message.output}` : message.content ?? message.summary ?? "";
      const content = typeof rawContent === "string" ? [{ type: "text", text: rawContent }] : rawContent;
      for (const block of content) {
        if (block.type === "toolCall") {
          const tool = this.agent.tools.get(block.id);
          if (tool) { lines.push(...this.renderTool(tool, width)); renderedTools.add(tool.id); }
          else lines.push(...new Text(clean(`${block.name ?? "tool"}\n${block.raw || JSON.stringify(block.arguments, null, 2) || ""}`), 0, 0).render(width));
        } else if (block.type === "thinking") {
          lines.push(...new Text(this.theme.fg("thinkingText", clean(block.thinking ?? "")), 0, 0).render(width));
        } else if (block.type === "text") {
          lines.push(...new Markdown(clean(block.text ?? ""), 0, 0, getMarkdownTheme()).render(width));
        } else lines.push(`[${clean(block.type ?? "content")}]`);
      }
      if (message.errorMessage) lines.push(...new Text(this.theme.fg("error", clean(message.errorMessage)), 0, 0).render(width));
      if (message.usage) {
        const u = message.usage;
        lines.push(this.theme.fg("dim", truncateToWidth(`↑${u.input ?? 0} ↓${u.output ?? 0} cache ${u.cacheRead ?? 0} · $${(u.cost?.total ?? 0).toFixed(4)}`, width)));
      }
      lines.push("");
    }
    // Nested calls can have no transcript block of their own.
    for (const tool of this.agent.tools.values()) if (!renderedTools.has(tool.id)) lines.push(...this.renderTool(tool, width));
    if (!lines.length) lines.push(truncateToWidth("Waiting for subagent output…", width));
    this.cache = { width, revision: this.agent.revision, lines };
    return lines;
  }

  render(width: number) {
    const height = Math.max(1, this.tui.terminal.rows);
    if (width < 4 || height < 9) return Array.from({ length: height }, (_, i) => truncateToWidth(i === 0 ? "Esc: Return to main agent" : "", width));
    this.input.focused = this.focused;
    const header = [truncateToWidth(this.theme.fg("accent", `${clean(this.agent.name)} (${clean(this.agent.agent)}) · ${this.agent.phase} · ${clean(this.agent.activity)} · ${this.agent.rpc ? `${this.agent.elapsed}s` : "saved"}`), width),
      truncateToWidth(this.theme.fg("dim", `Model: ${clean(this.agent.model ?? "default")}${this.agent.thinking ? ` · ${clean(this.agent.thinking)}` : ""} · Task: ${clean(this.agent.task).replace(/\n/g, " ")}`), width)];
    const inputLines = this.input.render(width).slice(0, Math.max(3, height - 7));
    const navigation = blueBox("Subagent", [" ← Return to main agent  [Esc]"], width);
    const hint = truncateToWidth(this.theme.fg("dim", this.status || "Enter: send · Shift+Enter: newline · PgUp/PgDn: history · Ctrl+C/Ctrl+D or /exit: stop"), width);
    this.viewportHeight = Math.max(1, height - header.length - navigation.length - inputLines.length - 1);
    const history = this.transcript(width);
    const maxScroll = Math.max(0, history.length - this.viewportHeight);
    if (Number.isFinite(this.scroll)) this.scroll = Math.min(this.scroll, maxScroll);
    const start = Number.isFinite(this.scroll) ? this.scroll : maxScroll;
    const visible = history.slice(start, start + this.viewportHeight);
    while (visible.length < this.viewportHeight) visible.push("");
    this.returnRow = header.length + this.viewportHeight + 1;
    return [...header, ...visible, ...navigation, hint, ...inputLines].slice(0, height);
  }

  invalidate() { this.cache = undefined; this.input.invalidate(); }
  dispose() {
    this.agent.off("change", this.onChange);
    this.agent.off("settled", this.onSettled);
  }
}
