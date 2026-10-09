import { ExtensionSelectorComponent, ExtensionInputComponent, ExtensionEditorComponent, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { nativeKeybindings } from "./native-context.ts";
import type { Subagent } from "./runtime.ts";
import type { RpcRecord } from "./rpc.ts";

/** Lifecycle wrapper only; all dialog layout/input is supplied by Pi. */
export class ChildDialog implements Component {
  focused = false;
  private readonly child: Component & { focused?: boolean; dispose?: () => void };
  private closed = false;
  private readonly cancelOnExit = () => this.cancel();
  private readonly cancelOnStop = () => { if (!this.agent.live) this.cancel(); };
  private removeInput: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly tui: TUI, theme: Theme, private readonly agent: Subagent, record: RpcRecord,
    private readonly done: (response: RpcRecord) => void, context: ExtensionContext) {
    const respond = (fields: RpcRecord) => this.close({ type: "extension_ui_response", id: record.id, ...fields });
    this.cancel = () => respond({ cancelled: true });
    const title = `[${agent.name}] ${record.title ?? record.method}`;
    if (["select", "confirm"].includes(record.method)) {
      const options = record.method === "confirm" ? ["Yes", "No"] : record.options ?? [];
      this.child = new ExtensionSelectorComponent(title, options, (value) => respond(record.method === "confirm" ? { confirmed: value === "Yes" } : { value }), this.cancel,
        { tui, timeout: record.timeout, description: record.message });
    } else if (record.method === "editor") {
      this.child = new ExtensionEditorComponent(tui, nativeKeybindings(), title, record.prefill, (value) => respond({ value }), this.cancel);
    } else this.child = new ExtensionInputComponent(title, record.placeholder, (value) => respond({ value }), this.cancel, { tui, timeout: record.timeout });
    if (record.timeout) this.timer = setTimeout(this.cancel, record.timeout);
    this.removeInput = context.ui.onTerminalInput((data) => {
      if (["escape", "ctrl+c", "ctrl+d"].some((key) => matchesKey(data, key as any))) { this.cancel(); return { consume: true }; }
    });
    agent.on("finished", this.cancelOnExit); agent.on("settled", this.cancelOnStop);
  }
  cancel: () => void = () => {};
  private close(response: RpcRecord) {
    if (this.closed) return;
    this.closed = true;
    try { this.dispose(); } catch (error) { this.agent.emit("fault", `Child dialog: ${String(error)}`); }
    finally { this.done(response); }
  }
  handleInput(data: string) { if (!this.closed) { this.child.handleInput?.(data); this.tui.requestRender(); } }
  render(width: number) { this.child.focused = this.focused; return this.child.render(width); }
  invalidate() { this.child.invalidate(); }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    try { this.child.dispose?.(); this.removeInput?.(); }
    finally { this.agent.off("finished", this.cancelOnExit); this.agent.off("settled", this.cancelOnStop); }
  }
}
