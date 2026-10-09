// Model-facing strings preserved from the last Psmux revision (d521b48).
// Historical pane terminology is intentionally kept out of backend decisions.
export const SPAWN_DESCRIPTION = "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
  "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
  "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate, assume, or summarize results after calling this tool. " +
  "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.";
export const LIST_DESCRIPTION = "List all available subagent definitions. " +
  "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
  "Project-local agents override global ones with the same name.";
export const MESSAGE_DESCRIPTION = "Send a message to a subagent by name. Names are unique within your session and persist after a subagent finishes, " +
  "so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session; " +
  "if it has finished, your message resumes that session and continues it. " +
  "`name` and `message` are both required. " +
  "Steering a running subagent returns immediately with a local acknowledgement and does NOT, by itself, emit a new result. " +
  "Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up. " +
  "DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
  "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.";
export const MESSAGE_SNIPPET = "Message a subagent by name: steers it if running, resumes it if finished (same name either way). " +
  "`name` and `message` are required. Steering returns immediately; resuming delivers its result later as a steer message. " +
  "Do not poll or fabricate results.";
export const QUESTION_DESCRIPTION = "Ask the orchestrator (the parent agent that spawned you) a single question and pause until they reply. " +
  "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
  "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
  "Your session stays open while you wait — the answer arrives as your next message, then you continue. " +
  "Ask exactly one question per call; make separate calls for unrelated questions.";
export const QUESTION_SNIPPET = "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing — instead of guessing.";
export const QUESTION_GUIDELINES = [
  "Ask exactly one question per tool call.",
  "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
  "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
  "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
  "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
  "After asking, stop and wait — the reply will arrive as your next message.",
];
export const QUESTION_ACK = "Question sent to the orchestrator. Stop here and wait — do not continue working or " +
  "assume an answer. Their reply will arrive as your next message.";
export const spawnAcknowledgement = (name: string) => `Sub-agent "${name}" launched and is now running in the background. ` +
  "Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. " +
  "The results will be delivered to you automatically as a steer message when the sub-agent finishes. " +
  "Until then, move on to other work or tell the user you're waiting.";
export const steerAcknowledgement = (name: string) => `Message delivered to running subagent "${name}". It picks this up at its next ` +
  "turn boundary. If it exits, its result still arrives as a steer message.";
export const resumeAcknowledgement = (name: string) => `Session "${name}" resumed.`;
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function resultPresentation(result: { exitCode: number; elapsed: number; summary: string; errorMessage?: string }, name: string): string {
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;
  if (result.errorMessage) return `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
    `(provider/agent error — auto-retry exhausted).\n\nError: ${result.errorMessage}\n\n` +
    "The subagent did not produce a result. You can retry by spawning a new " +
    `subagent or resume the session with subagent_message.${sessionRef}`;
  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}
export function questionPresentation(name: string, elapsed: number, question: string): string {
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;
  return `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${question}${replyHint}`;
}
export function taskPresentation(task: string, body: string | undefined, systemPromptMode: string | undefined, autoExit: boolean | undefined, sessionMode: string | undefined): string {
  if (sessionMode === "fork") return task;
  const modeHint = autoExit
    ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  const roleBlock = body && !systemPromptMode ? `\n\n${body}` : "";
  return `${roleBlock}\n\n${modeHint}\n\n${task}\n\n${summaryInstruction}`;
}
