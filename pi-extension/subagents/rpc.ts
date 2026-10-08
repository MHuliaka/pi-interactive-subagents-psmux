import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";

export type RpcRecord = Record<string, any>;
export type SpawnProcess = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/** LF-only framing: Unicode separators inside JSON strings are not record boundaries. */
export class JsonlDecoder {
  private buffer = "";
  constructor(private readonly receive: (record: RpcRecord) => void) {}
  push(chunk: string) {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim()) this.receive(JSON.parse(line));
    }
  }
}

/** One isolated Pi process. No shell, terminal emulator, polling, or sentinel files. */
export class PiRpc extends EventEmitter {
  readonly process: ChildProcessWithoutNullStreams;
  readonly closed: Promise<{ code: number; error?: string }>;
  private resolveClosed!: (result: { code: number; error?: string }) => void;
  private sequence = 0;
  private ended = false;
  private stopping?: Promise<void>;
  private stderr = "";
  private dialogs = new Set<string>();
  private forceKill?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(args: string[], options: SpawnOptionsWithoutStdio, launch: SpawnProcess = spawn) {
    super();
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.process = launch("pi", ["--mode", "rpc", ...args], { ...options, shell: false });
    const decoder = new JsonlDecoder((record) => this.receive(record));
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      try { decoder.push(chunk); }
      catch (error) { this.finish(1, `Invalid Pi RPC output: ${String(error)}`); this.process.kill(); }
    });
    this.process.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-16000); });
    this.process.stdin.on("error", (error) => { this.finish(1, error.message); this.process.kill(); });
    this.process.on("error", (error) => this.finish(1, error.message));
    this.process.on("close", (code) => this.finish(code ?? 1, code === 0 ? undefined : this.stderr.trim() || `Pi exited with code ${code}`));
  }

  private receive(record: RpcRecord) {
    if (this.ended) return;
    if (record.type === "response" && record.id) {
      const waiter = this.pending.get(record.id);
      if (waiter) {
        this.pending.delete(record.id);
        clearTimeout(waiter.timer);
        if (record.success) waiter.resolve(record.data);
        else waiter.reject(new Error(record.error || `${record.command} failed`));
      }
    }
    if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(record.method) && typeof record.id === "string") this.dialogs.add(record.id);
    this.emit("record", record);
  }

  request(type: string, fields: RpcRecord = {}, timeout = 30000): Promise<any> {
    if (this.ended) return Promise.reject(new Error("Subagent process is closed"));
    const id = `subagent-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ ...fields, id, type }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  write(record: RpcRecord) {
    if (this.ended || this.process.stdin.destroyed || this.process.stdin.writableEnded) throw new Error("Subagent process is closed");
    if (record.type === "extension_ui_response") this.dialogs.delete(record.id);
    this.process.stdin.write(JSON.stringify(record) + "\n");
  }

  prompt(message: string) {
    return this.request("prompt", { message, streamingBehavior: "steer" });
  }

  /** Idempotent orderly exit, with a bounded fallback if a child cannot settle. */
  stop(abort = true): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopProcess(abort);
    return this.stopping;
  }

  private async stopProcess(abort: boolean) {
    if (this.ended) return;
    this.forceKill = setTimeout(() => { if (!this.ended) this.process.kill(); }, 2500);
    try {
      // Tool execution can be blocked on a dialog; release it before awaiting abort.
      for (const id of this.dialogs) this.write({ type: "extension_ui_response", id, cancelled: true });
      if (abort) {
        // Abort would otherwise continue any queued follow-ups.
        await this.request("clear_queue", {}, 700);
        await this.request("abort", {}, 1000);
      }
    } catch { /* A crashed or unresponsive child still gets its stdin closed. */ }
    if (!this.process.stdin.destroyed && !this.process.stdin.writableEnded) this.process.stdin.end();
    await this.closed;
  }

  private finish(code: number, error?: string) {
    if (this.ended) return;
    this.ended = true;
    if (this.forceKill) clearTimeout(this.forceKill);
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(error || "Subagent process exited"));
    }
    this.pending.clear();
    this.dialogs.clear();
    const result = { code, ...(error ? { error } : {}) };
    this.resolveClosed(result);
    this.emit("closed", result);
  }
}
