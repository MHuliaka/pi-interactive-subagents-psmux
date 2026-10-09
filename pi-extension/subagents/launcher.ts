import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Use Pi's declared JavaScript entry point, not a platform-specific PATH shim. */
export function resolvePiLaunch(packageDir = getPackageDir(), runtime = process.execPath): { command: string; prefix: string[] } {
  let cli: string;
  try {
    const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (typeof bin !== "string" || !bin) throw new Error("package.json has no bin.pi entry");
    cli = resolve(packageDir, bin);
    if (!statSync(cli).isFile()) throw new Error(`${cli} is not a file`);
    if (!statSync(runtime).isFile()) throw new Error(`${runtime} is not a file`);
  } catch (error) {
    throw new Error(`Cannot launch Pi directly from ${packageDir}: ${String(error)}. A JavaScript Pi installation with its declared CLI and runtime is required.`);
  }
  return { command: runtime, prefix: [cli] };
}
