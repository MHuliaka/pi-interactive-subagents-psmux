import { readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Expand every requested profile skill into ONE initial RPC prompt/turn. */
export function buildTaskWithSkills(task: string, skills: string | undefined, commands: any[]): string {
  const names = (skills ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const blocks = names.map((name) => {
    const command = commands.find((c) => c.source === "skill" && c.name === `skill:${name}`);
    const path = command?.sourceInfo?.path;
    if (!path) throw new Error(`Skill "${name}" is not available in the subagent's working directory.`);
    const content = readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    return `Skill: ${name}\nLocation: ${path}\nReferences are relative to ${dirname(path)}.\n\n${content}`;
  });
  return [...blocks, task].join("\n\n");
}
