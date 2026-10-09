interface ContextMessage { role: string; customType?: string; content?: unknown; details?: unknown }
const TYPES = new Set(["subagent_result", "subagent_question", "subagent_error"]);

/** Only owned-agent results, questions and terminal failures belong in model context.
 * Renderers, display:true and triggerTurn:false do NOT establish this boundary. */
export function keepContextMessage(message: ContextMessage): boolean {
  if (message.role !== "custom" || !TYPES.has(message.customType ?? "")) return true;
  const details = message.details as Record<string, unknown> | undefined;
  if (details?.delivery === "observer" || details?.parent) return false;
  // Older descendant question notifications had no ownership metadata.
  const name = typeof details?.name === "string" ? details.name : typeof message.content === "string" ? /^Sub-?agent\s+"([^"]+)"/i.exec(message.content)?.[1] : undefined;
  if (name?.includes("/")) return false;
  if (message.customType === "subagent_error") return details?.phase === "failed";
  return true;
}

export function filterContext<T extends ContextMessage>(messages: T[]): T[] {
  return messages.filter(keepContextMessage);
}

/** Tree summaries use the original entries array, so preserve its identity. */
export function filterSummaryEntries(entries: any[]): void {
  const kept = entries.filter((entry) => entry.type !== "custom_message" || keepContextMessage({ role: "custom", ...entry }));
  entries.splice(0, entries.length, ...kept);
}
