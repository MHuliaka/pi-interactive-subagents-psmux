import { getMarkdownTheme, type ExtensionAPI, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { blueBox, clean } from "./view.ts";

/** Compact result cards only; child conversation messages still use native Pi components. */
export class SubagentResultCard implements Component {
  private expanded = false;
  private rendered = false;
  private globalExpanded: boolean;
  private readonly markdown: Markdown;
  constructor(private readonly content: string, expanded = false) {
    // Even if main's tools are expanded, new result notifications start collapsed.
    this.globalExpanded = expanded;
    this.markdown = new Markdown(content, 0, 0, getMarkdownTheme());
  }
  syncExpanded(expanded: boolean) {
    if (expanded !== this.globalExpanded) { this.globalExpanded = expanded; if (this.rendered) this.expanded = expanded; }
  }
  render(width: number) {
    this.rendered = true;
    if (!this.expanded) return blueBox("Subagent result", [` ▸ ${clean(this.content.split("\n")[0])} · click to expand`], width);
    return blueBox("Subagent result · ▾ click to collapse", this.markdown.render(Math.max(1, width - 2)), width);
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
      card = new SubagentResultCard(content, options.expanded);
      cards.set(message, card);
    } else card.syncExpanded(options.expanded);
    return card;
  };
  pi.registerMessageRenderer("subagent_result", renderer);
}
