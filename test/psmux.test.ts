import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bashPaneArgs,
  createSurface,
  createSurfaceSplit,
  isMuxAvailable,
  readScreen,
  readScreenAsync,
  closeSurface,
  sendCommand,
  sendLongCommand,
} from "../pi-extension/subagents/psmux.ts";

// Test native process calls without requiring a running Psmux server.
describe("Psmux backend", () => {
  let calls: Array<{ command: string; args: string[] }>;
  let savedEnv: Record<string, string | undefined>;
  let dir: string;
  const originalExecFile = childProcess.execFile;

  beforeEach(() => {
    savedEnv = Object.fromEntries(["PSMUX_SESSION", "TMUX", "TMUX_PANE", "PI_BASH_PATH"].map(key => [key, process.env[key]]));
    process.env.PSMUX_SESSION = "pi-tests";
    process.env.TMUX = "/tmp/psmux-test,1234,0";
    process.env.TMUX_PANE = "%1";
    process.env.PI_BASH_PATH = "C:/Program Files/Git/bin/bash.exe";
    dir = mkdtempSync(join(tmpdir(), "pi-psmux-unit-"));
    calls = [];
    mock.method(childProcess, "execFileSync", (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "split-window") return "%12\r\n";
      if (args[0] === "capture-pane") return "screen contents";
      return "";
    });
    const fakeExecFile = (command: string, args: string[], _options: unknown, callback: Function) => {
      calls.push({ command, args });
      callback(null, "async screen contents", "");
    };
    // The original execFile's custom promisifier is non-configurable, so replace
    // the function rather than using a mock proxy that retains that property.
    Object.defineProperty(fakeExecFile, promisify.custom, {
      value: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { stdout: "async screen contents", stderr: "" };
      },
    });
    childProcess.execFile = fakeExecFile as unknown as typeof childProcess.execFile;
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    // Let the debounced cosmetic layout execute while the process mock is active.
    await new Promise(resolve => setTimeout(resolve, 160));
    mock.restoreAll();
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires a Psmux session rather than accepting plain tmux", () => {
    delete process.env.PSMUX_SESSION;
    assert.equal(isMuxAvailable(), false);
    assert.throws(() => createSurface("worker"), /Psmux is required/);
    process.env.PSMUX_SESSION = "pi-tests";
    assert.equal(isMuxAvailable(), true);
    delete process.env.TMUX_PANE;
    assert.equal(isMuxAvailable(), false);
    assert.ok(calls.every(call => call.command !== "sh" && call.command !== "tmux"));
  });

  it("creates a detached Bash pane targeted at the parent", () => {
    assert.equal(createSurface("worker"), "%12");
    const split = calls.find(call => call.args[0] === "split-window")!;
    assert.equal(split.command, "psmux");
    assert.deepEqual(split.args, ["split-window", "-d", "-h", "-t", "%1", "-P", "-F", "#{pane_id}", '--', 'C:/Program Files/Git/bin/bash.exe', '--login', '-i']);
  });

  it("rejects a failed split that reports the parent pane", () => {
    process.env.TMUX_PANE = "%12";
    assert.throws(() => createSurface("worker"), /did not create a new pane/);
  });

  it("supports each split direction", () => {
    for (const direction of ["left", "right", "up", "down"] as const) {
      createSurfaceSplit("worker", direction, "%7");
      const args = calls.at(-1)!.args;
      assert.ok(args.includes(direction === "left" || direction === "right" ? "-h" : "-v"));
      assert.equal(args.includes("-b"), direction === "left" || direction === "up");
      assert.ok(args.includes("%7"));
    }
  });

  it("passes native executable paths as separate argv and rejects unsafe path syntax", () => {
    assert.deepEqual(bashPaneArgs("C:\\Program Files\\Git\\bin\\bash.exe"), ["--", "C:/Program Files/Git/bin/bash.exe", "--login", "-i"]);
    assert.throws(() => bashPaneArgs('bad"path'), /Invalid/);
    assert.throws(() => bashPaneArgs("bad\npath"), /Invalid/);
  });

  it("types commands literally, then presses Enter", () => {
    sendCommand("%12", "echo '$HOME'");
    assert.deepEqual(calls.slice(-2), [
      { command: "psmux", args: ["send-keys", "-t", "%12", "-l", "echo '$HOME'"] },
      { command: "psmux", args: ["send-keys", "-t", "%12", "Enter"] },
    ]);
  });

  it("writes LF Bash scripts and quotes paths containing spaces and apostrophes", () => {
    const path = join(dir, "worker's launch.sh");
    assert.equal(sendLongCommand("%12", "echo done", { scriptPath: path, scriptPreamble: "# test" }), path);
    assert.equal(readFileSync(path, "utf8"), "#!/bin/bash\n# test\necho done\n");
    const launch = calls.find(call => call.args.includes("-l"))!.args.at(-1)!;
    assert.ok(launch.startsWith("bash '"));
    assert.ok(launch.includes("worker'\\''s launch.sh"));
    if (process.platform === "win32") assert.ok(!launch.includes("\\Users"));
  });

  it("captures screens synchronously and asynchronously and closes panes", async () => {
    assert.equal(readScreen("%12", 0), "screen contents");
    assert.ok(calls.at(-1)!.args.includes("-1"));
    assert.equal(await readScreenAsync("%12", 20), "async screen contents");
    assert.ok(calls.at(-1)!.args.includes("-20"));
    closeSurface("%12");
    assert.deepEqual(calls.at(-1), { command: "psmux", args: ["kill-pane", "-t", "%12"] });
  });
});
