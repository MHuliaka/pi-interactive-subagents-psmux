import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentConnection, RpcRecord } from "./rpc.ts";

export type AgentPhase = "starting" | "running" | "waiting" | "completed" | "cancelled" | "failed";
export interface ToolActivity {
  id: string;
  name: string;
  args: any;
  result?: any;
  state: "running" | "completed" | "failed";
}

/** Presentation and lifecycle state, independent of the parent terminal. */
export class Subagent extends EventEmitter {
  phase: AgentPhase = "starting";
  parentId?: string;
  depth = 0;
  messages: any[] = [];
  tools = new Map<string, ToolActivity>();
  revision = 0;
  activity = "starting";
  error?: string;
  model?: string;
  thinking?: string;
  draft = "";
  readonly startedAt = Date.now();
  finishedAt?: number;
  private activeMessage = -1;
  private waitingAnswer = false;
  private children = 0;
  private finalizing = false;
  private reported = false;
  private cancelled = false;
  private removeRecord?: () => void;
  onDialog?: (record: RpcRecord) => void;

  constructor(
    readonly name: string,
    readonly agent: string,
    readonly task: string,
    readonly sessionFile: string,
    readonly autoExit: boolean,
    readonly rpc?: AgentConnection,
    readonly id: string = randomUUID(),
  ) {
    super();
    if (rpc) {
      const listener = (record: RpcRecord) => this.receive(record);
      const fault = (error: unknown) => this.emit("fault", String(error));
      rpc.on("record", listener);
      rpc.on("fault", fault);
      this.removeRecord = () => { rpc.off("record", listener); rpc.off("fault", fault); };
      void rpc.closed.then(({ code, error, phase }) => {
        if (rpc.remote && phase) {
          this.phase = phase;
          this.error = error;
        } else if (!this.cancelled && (!this.finalizing || code !== 0)) {
          this.error = error || (code !== 0 ? `Pi exited with code ${code}` : "Subagent exited before completing its task");
          this.phase = "failed";
        }
        if (this.error) this.emit("fault", this.error);
        this.finish();
      });
    }
  }

  get live() { return !!this.rpc && !this.finishedAt && !["completed", "cancelled", "failed"].includes(this.phase); }
  get elapsed() { return Math.floor(((this.finishedAt ?? Date.now()) - this.startedAt) / 1000); }
  get summary(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "assistant") {
        const text = (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        if (text) return text;
      }
    }
    return this.error || (this.phase === "cancelled" ? "Subagent cancelled." : "Subagent completed without text output.");
  }

  loadMessages(messages: any[]) {
    this.messages = messages.filter((m) => m.role !== "toolResult");
    this.tools.clear();
    for (const message of messages) {
      if (message.role === "assistant") {
        if (message.model) this.model = message.provider ? `${message.provider}/${message.model}` : message.model;
        if (Array.isArray(message.content)) for (const b of message.content) if (b.type === "toolCall") {
          this.tools.set(b.id, { id: b.id, name: b.name, args: b.arguments, state: "completed" });
        }
      }
      if (message.role === "toolResult") {
        const tool = this.tools.get(message.toolCallId);
        if (tool) { tool.result = message; tool.state = message.isError ? "failed" : "completed"; }
      }
    }
    this.activeMessage = -1;
    this.changed();
  }

  changed() { this.revision++; this.emit("change"); }

  receive(event: RpcRecord) {
    try { this.receiveRecord(event); }
    catch (error) { void this.fail(new Error(`Invalid subagent event: ${String(error)}`)).catch((failure) => this.emit("fault", String(failure))); }
  }

  private receiveRecord(event: RpcRecord) {
    if (this.finalizing || this.cancelled) return;
    switch (event.type) {
      case "response":
        if (this.rpc?.remote && event.command === "get_messages" && event.success) this.loadMessages(event.data?.messages ?? []);
        break;
      case "agent_start": this.phase = "running"; this.activity = "working"; break;
      case "message_start":
        if (event.message?.role === "toolResult") break; // Tool lifecycle renders this separately.
        this.activeMessage = this.messages.push(structuredClone(event.message)) - 1;
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        // Also tolerate the cumulative snapshots emitted by older Pi versions.
        if (event.message) this.messages[this.activeMessage] = event.message;
        else if (update && this.activeMessage >= 0) {
          const message = this.messages[this.activeMessage];
          const index = update.contentIndex;
          if (typeof index !== "number") break;
          message.content ??= [];
          const kind = update.type.split("_")[0];
          const type = kind === "toolcall" ? "toolCall" : kind;
          const block = message.content[index] ??= type === "toolCall"
            ? { type, id: update.id, name: update.toolName, arguments: {}, raw: "" }
            : { type, [kind === "thinking" ? "thinking" : "text"]: "" };
          const field = kind === "toolcall" ? "raw" : kind === "thinking" ? "thinking" : "text";
          if (update.type.endsWith("_delta")) block[field] = (block[field] ?? "") + update.delta;
          if (update.type.endsWith("_end")) {
            if (update.toolCall) message.content[index] = update.toolCall;
            else block[field] = update.content;
          }
          if (event.usage) message.usage = event.usage;
          this.activity = kind === "thinking" ? "thinking" : "streaming";
        }
        break;
      }
      case "message_end":
        if (event.message?.role === "toolResult") break;
        if (this.activeMessage >= 0) this.messages[this.activeMessage] = event.message;
        if (event.message?.model) this.model = event.message.provider ? `${event.message.provider}/${event.message.model}` : event.message.model;
        if (event.message?.errorMessage) { this.error = event.message.errorMessage; this.emit("fault", this.error); }
        else if (event.message?.role === "assistant" && event.message.stopReason !== "error") this.error = undefined;
        break;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, args: event.args, state: "running" });
        this.activity = event.toolName;
        break;
      case "tool_execution_update": {
        const tool = this.tools.get(event.toolCallId);
        if (tool) tool.result = event.partialResult;
        break;
      }
      case "tool_execution_end": {
        const tool = this.tools.get(event.toolCallId);
        if (tool) { tool.result = event.result; tool.state = event.isError ? "failed" : "completed"; }
        if (event.isError) this.emit("fault", `${tool?.name ?? "Tool"} failed: ${(event.result?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || "Unknown tool error"}`);
        break;
      }
      case "auto_retry_start":
        if (event.errorMessage) this.emit("fault", event.errorMessage);
        this.activity = `retry ${event.attempt}`;
        this.messages.push({ role: "custom", customType: "Retry", content: `Attempt ${event.attempt}/${event.maxAttempts ?? "?"}: ${event.errorMessage ?? "retrying"}` });
        break;
      case "auto_retry_end": if (!event.success) { this.error = event.finalError; if (this.error) this.emit("fault", this.error); } break;
      case "compaction_start": this.activity = "compacting"; break;
      case "compaction_end":
        if (event.result) this.messages.push({ role: "compactionSummary", summary: event.result.summary, usage: event.result.usage });
        else if (event.errorMessage) { this.messages.push({ role: "custom", customType: "Compaction error", content: event.errorMessage }); this.emit("fault", event.errorMessage); }
        break;
      case "thinking_level_changed": this.thinking = event.level; break;
      case "entry_appended": {
        const entry = event.entry;
        if (entry?.customType === "subagent_children") this.children = entry.data.count;
        if (entry?.customType === "subagent_question") {
          this.waitingAnswer = true;
          this.emit("question", entry.data.question);
        }
        break;
      }
      case "extension_ui_request":
        if (["select", "confirm", "input", "editor"].includes(event.method)) this.onDialog?.(event);
        else if (event.method === "notify") this.emit("notice", event.message, event.notifyType);
        break;
      case "extension_error": this.emit("fault", event.error || "Unknown extension error"); break;
      case "agent_settled":
        // agent_end is NOT final: automatic retries and queued prompts may follow it.
        this.emit("settled");
        if (this.rpc?.remote) {
          // Only the owner decides completion; a settled parent can still have busy children.
          this.phase = event.aborted ? "cancelled" : "waiting";
          this.activity = this.waitingAnswer ? "awaiting answer" : this.children > 0 ? "awaiting children" : "settled";
          break;
        }
        if (event.aborted) { void this.stop().catch((error) => this.emit("fault", String(error))); return; }
        if (this.waitingAnswer || this.children > 0) {
          this.phase = "waiting";
          this.activity = this.waitingAnswer ? "awaiting answer" : "awaiting children";
        } else if (this.autoExit || this.error) {
          this.finalizing = true;
          this.phase = this.error ? "failed" : "completed";
          // Preserve messages/session writes before reporting completion.
          void this.rpc?.stop(false).catch((error) => this.fail(error));
        } else {
          this.phase = "waiting";
          this.activity = "ready for a message";
        }
        break;
    }
    this.changed();
  }

  async send(message: string) {
    if (!this.live) throw new Error("Subagent is no longer running; resume it with subagent_message.");
    this.waitingAnswer = false;
    await this.rpc!.prompt(message);
  }

  async stop() {
    if (this.reported || !this.rpc) return;
    if (this.finalizing) { await this.rpc?.closed; return; }
    this.cancelled = true;
    this.finalizing = true;
    this.phase = "cancelled";
    this.emit("settled"); // Restore the main screen immediately, even if shutdown takes time.
    this.changed();
    try { await this.rpc?.stop(); }
    catch (error) { this.emit("fault", String(error)); }
    this.finish();
  }

  async fail(error: unknown) {
    if (this.reported || this.cancelled) return;
    this.error = error instanceof Error ? error.message : String(error);
    this.emit("fault", this.error);
    this.phase = "failed";
    this.finalizing = true;
    this.emit("settled");
    this.changed();
    try { await this.rpc?.stop(); }
    catch (failure) { this.emit("fault", String(failure)); }
    this.finish();
  }

  private finish() {
    if (this.reported) return;
    this.reported = true;
    this.finishedAt = Date.now();
    this.activity = this.phase;
    this.removeRecord?.();
    this.emit("settled");
    this.changed();
    this.emit("finished");
  }
}
