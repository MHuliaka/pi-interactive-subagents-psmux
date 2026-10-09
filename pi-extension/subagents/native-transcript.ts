import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, CustomMessageComponent, CompactionSummaryMessageComponent, BranchSummaryMessageComponent, BashExecutionComponent, SkillInvocationMessageComponent, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Subagent, ToolActivity } from "./runtime.ts";
import { nativePresentation, type NativePresentation } from "./native-context.ts";

/** Only composes Pi components. No substitute tool/Markdown/thinking/usage renderer. */
export class NativeTranscript implements Component {
  readonly container = new Container();
  private messages = new Map<number, { message: any; component: Component }>();
  private tools = new Map<string, ToolExecutionComponent>();
  private revision = -1;
  private expanded: boolean;
  private hiddenThinking?: boolean;
  constructor(private readonly agent: Subagent, private readonly tui: TUI, private readonly presentation: NativePresentation = nativePresentation(), private readonly cwd = process.cwd()) {
    this.expanded = presentation.toolsExpanded();
  }
  toggleTools() {
    this.expanded = !this.expanded;
    this.presentation.setToolsExpanded(this.expanded);
    for (const tool of this.tools.values()) tool.setExpanded(this.expanded);
    for (const entry of this.messages.values()) this.expandComponent(entry.component);
    this.tui.requestRender();
  }
  private expandComponent(component: Component) {
    if ("setExpanded" in component) (component as any).setExpanded(this.expanded);
    else if (component instanceof Container) for (const child of component.children) this.expandComponent(child);
  }
  toggleThinking() {
    this.hiddenThinking = !(this.hiddenThinking ?? this.presentation.settings().hideThinking);
    this.invalidate();
    this.tui.requestRender();
  }
  private guarded<T extends (...args: any[]) => any>(callback: T | undefined): T | undefined {
    if (!callback) return undefined;
    return ((...args: any[]) => {
      try { return callback(...args); }
      catch (error) { this.agent.emit("fault", `Native renderer: ${String(error)}`); throw error; }
    }) as T;
  }
  private tool(id: string, name: string, args: any, activity?: ToolActivity) {
    const options = this.presentation.settings();
    let component = this.tools.get(id);
    if (!component) {
      const definition = this.presentation.tool(name);
      const renderers = definition ? { ...definition, renderCall: this.guarded(definition.renderCall), renderResult: this.guarded(definition.renderResult) } : undefined;
      component = new ToolExecutionComponent(name, id, args, { outputPad: options.outputPad, showImages: options.showImages, imageWidthCells: options.imageWidthCells }, renderers, this.tui, this.cwd);
      component.setExpanded(this.expanded);
      this.tools.set(id, component);
    } else component.updateArgs(args);
    if (activity) {
      component.setArgsComplete();
      component.markExecutionStarted();
      if (activity.result) component.updateResult({ ...activity.result, isError: activity.state === "failed", durationMs: activity.durationMs }, activity.state === "running");
    }
    return component;
  }
  private rebuild() {
    if (this.revision === this.agent.revision) return;
    const settings = this.presentation.settings();
    const transformers = settings.transformers.map((transformer) => this.guarded(transformer)!);
    const used = new Set<string>();
    const seenMessages = new Set<number>();
    this.container.clear();
    for (let index = 0; index < this.agent.messages.length; index++) {
      const message = this.agent.messages[index];
      if (message.role === "toolExecution") {
        const activity = this.agent.tools.get(message.toolCallId);
        if (activity && !used.has(activity.id)) { this.container.addChild(this.tool(activity.id, activity.name, activity.args, activity)); used.add(activity.id); }
        continue;
      }
      let cached = this.messages.get(index);
      let component = cached?.component;
      if (message.role === "assistant") {
        if (!(component instanceof AssistantMessageComponent)) component = new AssistantMessageComponent(undefined, this.hiddenThinking ?? settings.hideThinking, settings.markdownTheme, settings.hiddenThinkingLabel, settings.outputPad, transformers);
        (component as AssistantMessageComponent).updateContent(message, this.agent.live && index === this.agent.streamingMessageIndex);
      } else if (!cached || cached.message !== message) {
        if (message.role === "user") {
          const text = typeof message.content === "string" ? message.content : message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
          if (!text) continue;
          const skill = parseSkillBlock(text);
          if (skill) {
            const group = new Container();
            const invocation = new SkillInvocationMessageComponent(skill, settings.markdownTheme, settings.outputPad);
            invocation.setExpanded(this.expanded);
            group.addChild(invocation);
            if (skill.userMessage) { group.addChild(new Spacer(1)); group.addChild(new UserMessageComponent(skill.userMessage, settings.markdownTheme, settings.outputPad, transformers)); }
            component = group;
          } else component = new UserMessageComponent(text, settings.markdownTheme, settings.outputPad, transformers);
        } else if (message.role === "custom" && message.display !== false) {
          component = new CustomMessageComponent(message, this.guarded(this.presentation.message(message.customType)), settings.markdownTheme, settings.outputPad);
          (component as CustomMessageComponent).setExpanded(this.expanded);
        } else if (message.role === "customEntry") component = this.presentation.entry(message.entry, settings.outputPad, (error) => this.agent.emit("fault", `Native renderer: ${String(error)}`));
        else if (message.role === "compactionSummary") component = new CompactionSummaryMessageComponent(message, settings.markdownTheme, settings.outputPad);
        else if (message.role === "branchSummary") component = new BranchSummaryMessageComponent(message, settings.markdownTheme, settings.outputPad);
        else if (message.role === "bashExecution") {
          const bash = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext, settings.outputPad);
          bash.appendOutput(message.output ?? "");
          bash.setComplete(message.exitCode, message.cancelled ?? false, message.truncated ? { truncated: true } as Parameters<BashExecutionComponent["setComplete"]>[2] : undefined, message.fullOutputPath);
          bash.setExpanded(this.expanded);
          component = bash;
        } else component = undefined;
      }
      if (component) {
        if (message.role === "compactionSummary" || message.role === "branchSummary" || (message.role === "user" && this.container.children.length)) this.container.addChild(new Spacer(1));
        if (!cached || component !== cached.component) this.expandComponent(component);
        this.container.addChild(component);
        this.messages.set(index, { message, component });
        seenMessages.add(index);
      }
      if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") {
        if (used.has(block.id)) continue;
        const tool = this.tool(block.id, block.name, block.arguments, this.agent.tools.get(block.id));
        if (["error", "aborted"].includes(message.stopReason)) tool.updateResult({ content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error") }], isError: true });
        this.container.addChild(tool);
        used.add(block.id);
      }
    }
    for (const activity of this.agent.tools.values()) if (!used.has(activity.id)) { this.container.addChild(this.tool(activity.id, activity.name, activity.args, activity)); used.add(activity.id); }
    for (const id of this.tools.keys()) if (!used.has(id)) this.tools.delete(id);
    for (const index of this.messages.keys()) if (!seenMessages.has(index)) this.messages.delete(index);
    this.revision = this.agent.revision;
  }
  render(width: number) { this.rebuild(); return this.container.render(width); }
  handleMouse(event: TuiMouseEvent) { return this.container.handleMouse(event); }
  invalidate() {
    this.revision = -1;
    this.messages.clear();
    for (const tool of this.tools.values()) tool.invalidate();
    this.container.invalidate();
  }
}
