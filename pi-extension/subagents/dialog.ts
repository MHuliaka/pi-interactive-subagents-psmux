import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Input, Text, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { ModelPickerComponent } from "./model-picker.ts";
import type { Subagent } from "./runtime.ts";
import type { RpcRecord } from "./rpc.ts";

/** A child dialog owns its own completion callback, so exit cannot strand the parent UI. */
export class ChildDialog implements Component {
  focused = false;
  private readonly child: Component & { focused?: boolean };
  private closed = false;
  private readonly cancelOnExit = () => this.cancel();
  private readonly cancelOnStop = () => { if (!this.agent.live) this.cancel(); };
  private removeInput: () => void;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly tui: TUI, theme: Theme, private readonly agent: Subagent, record: RpcRecord,
    private readonly done: (response: RpcRecord) => void, context: ExtensionContext) {
    const respond = (fields: RpcRecord) => this.close({ type: "extension_ui_response", id: record.id, ...fields });
    const title = `[${agent.name}] ${record.title ?? record.method}`;
    if (record.method === "select" || record.method === "confirm") {
      const options = record.method === "confirm" ? ["Yes", "No"] : record.options ?? [];
      this.child = new ModelPickerComponent(theme, { title: record.message ? `${title}\n${record.message}` : title,
        items: options.map((label: string, i: number) => ({ value: String(i), label, searchText: label })) }, (index) => {
        if (index === undefined) respond({ cancelled: true });
        else if (record.method === "confirm") respond({ confirmed: index === "0" });
        else respond({ value: options[Number(index)] });
      });
    } else {
      const input = record.method === "editor" ? new Editor(tui, {
        borderColor: (text) => theme.fg("border", text),
        selectList: { selectedPrefix: (t) => theme.fg("accent", t), selectedText: (t) => theme.fg("accent", t), description: (t) => theme.fg("muted", t), scrollInfo: (t) => theme.fg("muted", t), noMatch: (t) => theme.fg("muted", t) },
      }) : new Input();
      if (input instanceof Editor) input.setText(record.prefill ?? "");
      input.onSubmit = (value) => respond({ value });
      this.child = {
        focused: false,
        handleInput: (data) => input.handleInput(data),
        invalidate: () => input.invalidate(),
        render: (width) => {
          input.focused = this.focused;
          return [...new Text(theme.fg("accent", title), 0, 0).render(width),
            ...new Text(record.placeholder ?? "", 0, 0).render(width), ...input.render(width),
            ...new Text("Enter: answer · Esc: cancel", 0, 0).render(width)];
        },
      };
    }
    this.cancel = () => respond({ cancelled: true });
    this.removeInput = context.ui.onTerminalInput((data) => {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
        respond({ cancelled: true });
        return { consume: true };
      }
      return undefined;
    });
    this.agent.on("finished", this.cancelOnExit);
    this.agent.on("settled", this.cancelOnStop);
    if (record.timeout) this.timer = setTimeout(() => respond({ cancelled: true }), record.timeout);
  }

  cancel: () => void = () => {};
  private close(response: RpcRecord) {
    if (this.closed) return;
    this.closed = true;
    try { this.dispose(); }
    catch (error) { this.agent.emit("fault", `Child dialog: ${String(error)}`); }
    finally { this.done(response); }
  }
  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) this.cancel();
    else this.child.handleInput?.(data);
    this.tui.requestRender();
  }
  render(width: number) { this.child.focused = this.focused; return this.child.render(width); }
  invalidate() { this.child.invalidate(); }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    try { this.removeInput?.(); }
    finally {
      this.agent.off("finished", this.cancelOnExit);
      this.agent.off("settled", this.cancelOnStop);
    }
  }
}
