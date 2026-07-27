#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = await readJson("package.json");
const expectedBunVersion = String(rootManifest.packageManager || "").replace(/^bun@/, "");
const expectedNodeVersion = "22.17.0";
const failures = [];

if (!expectedBunVersion) {
  failures.push("package.json must declare packageManager as bun@<version>.");
} else if (Bun.version !== expectedBunVersion) {
  failures.push(
    `Bun ${expectedBunVersion} is required, but ${Bun.version} is running. ` +
      "Install the pinned version before building or changing bun.lock.",
  );
}

const nodeVersionResult = Bun.spawnSync({
  cmd: ["node", "--version"],
  cwd: repositoryRoot,
  stdout: "pipe",
  stderr: "pipe",
});
const actualNodeVersion = new TextDecoder().decode(nodeVersionResult.stdout).trim().replace(/^v/, "");
if (nodeVersionResult.exitCode !== 0 || actualNodeVersion !== expectedNodeVersion) {
  failures.push(
    `Node ${expectedNodeVersion} is required for Jest/Expo, but ${actualNodeVersion || "no Node runtime"} is available.`,
  );
}

if (
  !Array.isArray(rootManifest.workspaces) ||
  rootManifest.workspaces.length !== 1 ||
  rootManifest.workspaces[0] !== "packages/*"
) {
  failures.push("package.json workspaces must be exactly packages/*.");
}

if (Object.keys(rootManifest.dependencies || {}).length > 0) {
  failures.push("Runtime dependencies must live in their owning workspace, not the repository root.");
}

const frontendManifest = await readJson("packages/frontend/package.json");
const installedExpo = await readJson("node_modules/expo/package.json");
const installedBloom = await readJson("node_modules/@oxyhq/bloom/package.json");

if (!String(frontendManifest.dependencies?.expo || "").startsWith("~56.")) {
  failures.push(`Mention frontend must target Expo 56 (found ${String(frontendManifest.dependencies?.expo)}).`);
}
if (!String(installedExpo.version || "").startsWith("56.")) {
  failures.push(`Installed Expo must be version 56.x (found ${String(installedExpo.version)}).`);
}
if (frontendManifest.dependencies?.react !== "19.2.3") {
  failures.push(`Mention frontend must target React 19.2.3 (found ${String(frontendManifest.dependencies?.react)}).`);
}
if (frontendManifest.dependencies?.["react-native"] !== "0.85.3") {
  failures.push(
    `Mention frontend must target React Native 0.85.3 (found ${String(frontendManifest.dependencies?.["react-native"])}).`,
  );
}
if (
  frontendManifest.dependencies?.["@oxyhq/bloom"] !== "^0.52.0" ||
  rootManifest.overrides?.["@oxyhq/bloom"] !== "^0.52.0" ||
  installedBloom.version !== "0.52.0"
) {
  failures.push(
    `Bloom must stay aligned at manifest/override ^0.52.0 and installed 0.52.0 ` +
      `(found ${String(frontendManifest.dependencies?.["@oxyhq/bloom"])}, ` +
      `${String(rootManifest.overrides?.["@oxyhq/bloom"])}, ${String(installedBloom.version)}).`,
  );
}

for (const packageName of ["backend", "frontend", "mcp"]) {
  const manifest = await readJson(`packages/${packageName}/package.json`);
  const range =
    manifest.dependencies?.["@mention/shared-types"] ??
    manifest.devDependencies?.["@mention/shared-types"];

  if (range !== "workspace:*") {
    failures.push(
      `packages/${packageName}/package.json must declare @mention/shared-types as workspace:* (found ${String(range)}).`,
    );
  }
}

const rootTsconfig = await readFile(resolve(repositoryRoot, "tsconfig.json"), "utf8");
if (/packages\/agora(?:-shared)?/.test(rootTsconfig)) {
  failures.push("tsconfig.json still references a removed Agora package.");
}

if (failures.length > 0) {
  console.error("Mention workspace doctor found configuration drift:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Mention workspace is reproducible: Bun ${Bun.version}, Node ${actualNodeVersion}, Expo ${installedExpo.version}, ` +
    `Bloom ${installedBloom.version}, workspace dependencies and TypeScript references are aligned.`,
);

async function readJson(relativePath) {
  const contents = await readFile(resolve(repositoryRoot, relativePath), "utf8");
  return JSON.parse(contents);
}
