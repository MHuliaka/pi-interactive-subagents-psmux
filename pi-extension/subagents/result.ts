import { getMarkdownTheme, type ExtensionAPI, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { blueBox, clean } from "./view.ts";

type CardKind = "result" | "error" | "question";
const GRAY_BG = "\x1b[48;2;48;48;48m";

/** Main-chat notifications only; child conversations still use native Pi components. */
export class SubagentResultCard implements Component {
  private expanded: boolean;
  private rendered = false;
  private globalExpanded: boolean;
  private readonly markdown: Markdown;
  constructor(private readonly content: string, expanded = false, private readonly kind: CardKind = "result") {
    this.expanded = kind === "error";
    // Result/question notifications start collapsed even if main's tools are expanded.
    this.globalExpanded = expanded;
    this.markdown = new Markdown(content, 0, 0, getMarkdownTheme());
  }
  syncExpanded(expanded: boolean) {
    if (expanded !== this.globalExpanded) { this.globalExpanded = expanded; if (this.rendered) this.expanded = expanded; }
  }
  render(width: number) {
    this.rendered = true;
    if (width < 1) return [""];
    const action = this.expanded ? "▾ click to collapse" : "▸ click to expand";
    if (this.kind === "question") {
      const box = new Box(1, 0, (line) => `${GRAY_BG}${line}\x1b[49m`);
      box.addChild(new Text(truncateToWidth(`Subagent question · ${action}`, Math.max(0, width - 2)), 0, 0));
      if (this.expanded) box.addChild(this.markdown);
      else box.addChild(new Text(truncateToWidth(clean(this.content.split("\n").filter((line) => line.trim()).slice(0, 2).join(" ")), Math.max(0, width - 2)), 0, 0));
      const lines = box.render(Math.max(1, width));
      // Text wrapping must not turn a collapsed question back into a large block.
      return this.expanded ? lines : lines.slice(0, 2);
    }
    const title = this.kind === "error" ? "Subagent error" : "Subagent result";
    if (!this.expanded) return blueBox(title, [` ▸ ${clean(this.content.split("\n")[0])} · click to expand`], width);
    const heading = this.kind === "error" ? [" Error", ""] : [];
    return blueBox(`${title} · ${action}`, [...heading, ...this.markdown.render(Math.max(1, width - 2))], width);
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== "click" || event.button !== "left") return;
    this.expanded = !this.expanded;
    return { handled: true, render: true };
  }
  invalidate() { this.markdown.invalidate(); }
}

export function registerResultRenderer(pi: ExtensionAPI) {
  const cards = new WeakMap<object, SubagentResultCard>();
  const renderer: MessageRenderer = (message, options) => {
    let card = cards.get(message);
    if (!card) {
      const content = typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const kind = message.customType === "subagent_error" ? "error" : message.customType === "subagent_question" ? "question" : "result";
      card = new SubagentResultCard(content, options.expanded, kind);
      cards.set(message, card);
    } else card.syncExpanded(options.expanded);
    return card;
  };
  for (const type of ["subagent_result", "subagent_error", "subagent_question"]) pi.registerMessageRenderer(type, renderer);
  // Custom session entries have renderers, but are not AgentMessages and cannot
  // become provider/compaction context. Preserve cards without sendMessage().
  pi.registerEntryRenderer?.("subagent_ui", (entry, options, theme) => renderer(entry.data as Parameters<MessageRenderer>[0], { expanded: options.expanded, outputPad: 1 }, theme));
}
