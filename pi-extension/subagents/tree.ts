import { EventEmitter } from "node:events";
import { PiRpc, TREE_CHANNEL, type AgentConnection, type RpcExit, type RpcRecord } from "./rpc.ts";
import { Subagent } from "./runtime.ts";

export interface TreeNode {
  name: string;
  agent: string;
  task: string;
  sessionFile: string;
  autoExit: boolean;
  pid?: number;
  model?: string;
  thinking?: string;
}
export interface TreePacket {
  channel: typeof TREE_CHANNEL;
  kind: "spawn" | "record" | "closed" | "fault";
  route: string[];
  node?: TreeNode;
  record?: RpcRecord;
  result?: RpcExit;
  error?: string;
}

/** A root-side observer/control connection. It does not own a second Pi process. */
export class RemoteConnection extends EventEmitter implements AgentConnection {
  readonly remote = true;
  readonly closed: Promise<RpcExit>;
  private resolveClosed!: (result: RpcExit) => void;
  private ended = false;
  private closing = false;
  constructor(readonly owner: PiRpc, readonly route: string[], readonly pid?: number) {
    super();
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }
  get exitConfirmed() { return this.ended; }
  markClosing() { if (this.closing) return false; this.closing = true; return true; }
  receive(record: RpcRecord) {
    if (this.ended || (this.closing && ["agent_start", "agent_settled"].includes(record.type))) return;
    this.emit("record", record);
  }
  end(result: RpcExit) {
    if (this.ended) return;
    this.ended = true;
    this.resolveClosed(result);
  }
  private request(action: string, fields: RpcRecord = {}) {
    if (this.ended || this.closing) return Promise.reject(new Error("Subagent or its ancestor is closing"));
    return this.owner.treeRequest(this.route, action, fields);
  }
  prompt(message: string) { return this.request("prompt", { message }); }
  write(record: RpcRecord) {
    if (this.ended || this.closing) throw new Error("Subagent or its ancestor is closing");
    void this.request("write", { record }).catch((error) => this.emit("fault", String(error)));
  }
  async stop() {
    if (this.ended) return;
    // A concurrent ancestor shutdown already owns this cancellation.
    if (this.closing) { await this.closed; return; }
    try { await this.request("stop"); }
    catch (error) {
      if (!this.ended) {
        if (this.pid && this.pid !== process.pid) { try { process.kill(this.pid); } catch { /* Already exited. */ } }
        this.end({ code: 1, phase: "failed", error: String(error) });
        throw error;
      }
    }
    await this.closed;
  }
}

/** Each hop relays structured events upward and routes user controls downward. */
export class TreeBridge {
  readonly hasParent = !!process.env.PI_SUBAGENT_ID && typeof process.send === "function";
  private subscriptions: (() => void)[] = [];
  private queue: { packet: any; source?: PiRpc }[] = [];
  private paused = new Map<PiRpc, number>();
  private sending = false;
  private readonly command = (packet: any) => {
    if (packet?.channel !== TREE_CHANNEL || packet.kind !== "command") return;
    void this.routeCommand(packet).then(
      (data) => this.send({ channel: TREE_CHANNEL, kind: "reply", id: packet.id, success: true, data }),
      (error) => this.send({ channel: TREE_CHANNEL, kind: "reply", id: packet.id, success: false, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  constructor(
    private readonly lookup: (id: string) => Subagent | undefined,
    private readonly observe: (owner: Subagent, packet: TreePacket) => void,
    private readonly onError: (error: unknown) => void,
  ) {
    if (this.hasParent) process.on("message", this.command);
  }

  connect(agent: Subagent) {
    if (!(agent.rpc instanceof PiRpc)) return;
    const rpc = agent.rpc;
    this.send({ channel: TREE_CHANNEL, kind: "spawn", route: [agent.id], node: {
      name: agent.name, agent: agent.agent, task: agent.task, sessionFile: agent.sessionFile,
      autoExit: agent.autoExit, pid: rpc.process.pid, model: agent.model, thinking: agent.thinking,
    } });
    const record = (record: RpcRecord) => this.send({ channel: TREE_CHANNEL, kind: "record", route: [agent.id], record }, rpc);
    const tree = (packet: TreePacket) => {
      try {
        if (!Array.isArray(packet.route) || !packet.route.every((id) => typeof id === "string" && id.length > 0)) throw new Error("Invalid subagent route");
        const forwarded = { ...packet, route: [agent.id, ...packet.route] };
        if (this.hasParent) this.send(forwarded, rpc);
        else this.observe(agent, forwarded);
      } catch (error) {
        this.onError(error);
        void agent.fail(new Error(`Subagent tree protocol error: ${String(error)}`)).catch(this.onError);
      }
    };
    const finished = () => this.send({ channel: TREE_CHANNEL, kind: "closed", route: [agent.id], result: {
      code: agent.phase === "failed" ? 1 : 0, phase: agent.phase, error: agent.error,
    } });
    if (this.hasParent) rpc.on("record", record);
    rpc.on("tree", tree);
    agent.once("finished", finished);
    this.subscriptions.push(() => { rpc.off("record", record); rpc.off("tree", tree); agent.off("finished", finished); });
  }

  fault(agent: Subagent | undefined, error: string) {
    this.send({ channel: TREE_CHANNEL, kind: "fault", route: agent ? [agent.id] : [], error });
  }

  private async routeCommand(packet: any) {
    if (typeof packet.id !== "string" || !Array.isArray(packet.route) || !packet.route.length || !packet.route.every((id: any) => typeof id === "string")) throw new Error("Invalid subagent command");
    const agent = this.lookup(packet.route[0]);
    if (!agent || !(agent.rpc instanceof PiRpc) || agent.finishedAt) throw new Error("Subagent owner is no longer available");
    if (packet.route.length > 1) return agent.rpc.treeRequest(packet.route.slice(1), packet.action, { message: packet.message, record: packet.record });
    if (packet.action === "stop") { await agent.stop(); return; }
    if (!agent.live) throw new Error("Subagent is closing");
    if (packet.action === "prompt" && typeof packet.message === "string" && packet.message.trim()) return agent.send(packet.message);
    if (packet.action === "write" && packet.record?.type === "extension_ui_response" && typeof packet.record.id === "string") { agent.rpc.write(packet.record); return; }
    throw new Error("Unsupported subagent command");
  }

  // Honor IPC backpressure without persisting every streaming delta in parent sessions.
  private send(packet: any, source?: PiRpc) {
    if (!this.hasParent || !process.connected) return;
    if (source) { this.paused.set(source, (this.paused.get(source) ?? 0) + 1); source.process.stdout.pause(); }
    this.queue.push({ packet, source });
    this.pump();
  }
  private pump() {
    if (this.sending || !this.queue.length) return;
    if (!process.connected || !process.send) { this.release(); return; }
    this.sending = true;
    const item = this.queue.shift()!;
    const complete = (error: Error | null) => {
      if (item.source) {
        const remaining = (this.paused.get(item.source) ?? 1) - 1;
        if (remaining) this.paused.set(item.source, remaining);
        else { this.paused.delete(item.source); item.source.process.stdout.resume(); }
      }
      this.sending = false;
      if (error) { this.release(); return; }
      this.pump();
    };
    try { process.send(item.packet, complete); }
    catch (error) { complete(error instanceof Error ? error : new Error(String(error))); }
  }
  private release() {
    this.queue = [];
    for (const source of this.paused.keys()) source.process.stdout.resume();
    this.paused.clear();
  }
  async dispose() {
    process.off("message", this.command);
    for (const remove of this.subscriptions) remove();
    this.subscriptions = [];
    // Let final descendant states reach the root before Pi exits this process.
    const deadline = Date.now() + 1000;
    while ((this.sending || this.queue.length) && process.connected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    this.release();
  }
}
