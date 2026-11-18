// Downloads the Node.js binary bundled with PowerCode to run extensions, as a
// Tauri sidecar: src-tauri/binaries/node-<target triple>[.exe]. Skips the
// download when it is already there.
//
//   node scripts/fetch-node.mjs [target-triple]

import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "24.19.0";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const triple =
  process.argv[2] ??
  execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))
    .slice(5)
    .trim();

/** Node's distribution name for a Rust target triple. */
function nodePlatform(target) {
  const arch = target.startsWith("x86_64") ? "x64" : target.startsWith("aarch64") ? "arm64" : null;
  if (!arch) throw new Error(`Unsupported architecture: ${target}`);
  if (target.includes("windows")) return { name: `win-${arch}`, windows: true };
  if (target.includes("apple-darwin")) return { name: `darwin-${arch}`, windows: false };
  if (target.includes("linux")) return { name: `linux-${arch}`, windows: false };
  throw new Error(`Unsupported platform: ${target}`);
}

const platform = nodePlatform(triple);
const outDir = join(root, "src-tauri", "binaries");
const out = join(outDir, `node-${triple}${platform.windows ? ".exe" : ""}`);
if (existsSync(out)) {
  console.log(`Node ${NODE_VERSION} for ${triple} is already in place.`);
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });

async function download(url, file) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  await pipeline(response.body, createWriteStream(file));
}

const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
if (platform.windows) {
  // Windows releases publish the bare executable.
  await download(`${base}/${platform.name}/node.exe`, `${out}.part`);
  renameSync(`${out}.part`, out);
} else {
  const archive = join(tmpdir(), `node-v${NODE_VERSION}-${platform.name}.tar.gz`);
  await download(`${base}/node-v${NODE_VERSION}-${platform.name}.tar.gz`, archive);
  const extracted = join(tmpdir(), `node-v${NODE_VERSION}-${platform.name}`);
  execFileSync("tar", ["-xzf", archive, "-C", tmpdir()]);
  renameSync(join(extracted, "bin", "node"), out);
  rmSync(extracted, { recursive: true, force: true });
  rmSync(archive, { force: true });
}
console.log(`Node ${NODE_VERSION} for ${triple} -> ${out}`);
