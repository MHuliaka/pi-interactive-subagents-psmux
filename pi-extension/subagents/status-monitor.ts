import type { PiRpc } from "./rpc.ts";
import type { Subagent } from "./runtime.ts";
import { createStatusState, observeStatus, advanceStatusState, formatTransitionLine, type SubagentStatusState } from "./status.ts";

/** Replace activity-file observations with portable RPC health observations.
 * Keep the original classifier, timeout and interactive notification policy. */
export class StatusMonitor {
  private states = new Map<Subagent, { state: SubagentStatusState; pending: boolean; sequence: number }>();
  constructor(private readonly clock = Date.now) {}
  clear() { this.states.clear(); }
  tick(agents: Subagent[], now = this.clock()): string[] {
    const live = new Set(agents.filter((a) => a.live && !a.rpc?.remote));
    for (const agent of this.states.keys()) if (!live.has(agent)) this.states.delete(agent);
    const lines: string[] = [];
    for (const agent of live) {
      let record = this.states.get(agent);
      if (!record) {
        record = { state: createStatusState({ source: "pi", startTimeMs: agent.startedAt }), pending: false, sequence: 0 };
        this.states.set(agent, record);
      }
      const advanced = advanceStatusState(record.state, now);
      record.state = advanced.nextState;
      agent.statusKind = advanced.snapshot.kind;
      if (advanced.transition && !agent.interactive) lines.push(formatTransitionLine(agent.name, advanced.snapshot, advanced.transition));
      if (!record.pending) {
        record.pending = true;
        const current = record;
        void (agent.rpc as PiRpc).request("get_state", {}, 2000).then(() => {
          current.state = observeStatus(current.state, { snapshot: "present", updatedAt: this.clock(), sequence: ++current.sequence,
            phase: agent.phase === "waiting" ? "waiting" : agent.phase === "starting" ? "starting" : "active",
            activeScope: agent.activity, activityLabel: agent.activity }, this.clock());
        }, () => {
          current.state = observeStatus(current.state, { snapshot: "missing" }, this.clock());
        }).finally(() => { current.pending = false; });
      }
    }
    return lines;
  }
}
