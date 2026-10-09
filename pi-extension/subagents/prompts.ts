/** Reproduce the old CLI message order. Blank-session @file content is the
 * initial prompt; skill commands follow it. Fork sessions receive skills first
 * and the raw task last. Let Pi expand skill commands, not a substitute parser. */
export function buildInitialPrompts(task: string, skills: string | undefined, commands: any[], artifact: boolean): string[] {
  const names = (skills ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    if (!commands.some((c) => c.source === "skill" && c.name === `skill:${name}`)) {
      throw new Error(`Skill "${name}" is not available in the subagent's working directory.`);
    }
  }
  const prompts = names.map((name) => `/skill:${name}`);
  return artifact ? [task, ...prompts] : [...prompts, task];
}
