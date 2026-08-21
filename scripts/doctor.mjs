#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = await readJson("package.json");
const expectedBunVersion = String(rootManifest.packageManager || "").replace(/^bun@/, "");
const expectedNodeVersion = "22.17.0";
const failures = [];

// Shared dependency versions live in ONE place: the root `workspaces.catalog`.
// Workspace manifests reference it as "catalog:". Root overrides normally do
// too; the narrow Core/Services peer-resolution exception is documented and
// equality-gated below, so taking a new release still starts with this catalog.
const catalog = (!Array.isArray(rootManifest.workspaces) && rootManifest.workspaces?.catalog) || {};
const CATALOG_REFERENCE = "catalog:";
const expectedBloomVersion = String(catalog["@oxyhq/bloom"] ?? "").replace(/^\^/, "");
// The Expo SDK line and the React Native release it pairs with. Same rule as
// Bloom above: bump these two constants when taking a new SDK, and the manifest
// and installed-copy assertions below follow. They were spelled out inline until
// SDK 57, which meant an upgrade passed local review and failed here instead.
const expectedExpoMajor = "57";
const expectedReactNativeVersion = "0.86.0";

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
  Array.isArray(rootManifest.workspaces) ||
  !Array.isArray(rootManifest.workspaces?.packages) ||
  rootManifest.workspaces.packages.length !== 1 ||
  rootManifest.workspaces.packages[0] !== "packages/*"
) {
  failures.push(
    "package.json workspaces must be the object form { packages: [\"packages/*\"], catalog: {…} }.",
  );
}

if (Object.keys(catalog).length === 0) {
  failures.push("package.json workspaces.catalog is empty; shared versions must be declared there.");
}

// The Bun type definitions describe the runtime that actually executes the
// backend and MCP images, so a version other than the pinned toolchain's would
// be describing a different Bun than the one we ship.
if (catalog["@types/bun"] !== expectedBunVersion) {
  failures.push(
    `workspaces.catalog["@types/bun"] must be ${expectedBunVersion} to match packageManager ` +
      `(found ${String(catalog["@types/bun"])}).`,
  );
}

if (Object.keys(rootManifest.dependencies || {}).length > 0) {
  failures.push("Runtime dependencies must live in their owning workspace, not the repository root.");
}

const frontendManifest = await readJson("packages/frontend/package.json");
const installedExpo = await readJson("node_modules/expo/package.json");
const installedBloom = await readJson("node_modules/@oxyhq/bloom/package.json");

if (!String(frontendManifest.dependencies?.expo || "").startsWith(`~${expectedExpoMajor}.`)) {
  failures.push(
    `Mention frontend must target Expo ${expectedExpoMajor} (found ${String(frontendManifest.dependencies?.expo)}).`,
  );
}
if (!String(installedExpo.version || "").startsWith(`${expectedExpoMajor}.`)) {
  failures.push(
    `Installed Expo must be version ${expectedExpoMajor}.x (found ${String(installedExpo.version)}).`,
  );
}
if (frontendManifest.dependencies?.react !== "19.2.3") {
  failures.push(`Mention frontend must target React 19.2.3 (found ${String(frontendManifest.dependencies?.react)}).`);
}
if (frontendManifest.dependencies?.["react-native"] !== expectedReactNativeVersion) {
  failures.push(
    `Mention frontend must target React Native ${expectedReactNativeVersion} ` +
      `(found ${String(frontendManifest.dependencies?.["react-native"])}).`,
  );
}
if (installedBloom.version !== expectedBloomVersion) {
  failures.push(
    `Bloom must be installed at the catalogued ${expectedBloomVersion} (found ${String(installedBloom.version)}).`,
  );
}

// A catalogued package that a manifest re-pins to a literal range silently
// escapes the catalog: the version still resolves, so nothing else here notices,
// and the workspace is back to carrying the same number in several places. Every
// declaration of a catalogued package — workspace manifests and the root
// overrides alike — must therefore be the reference itself.
//
// Bun 1.3.14 does not apply a `catalog:` override to incompatible auto-installed
// peers. Alia/Syra would therefore receive Services 28 (and Core 20) beside the
// app's Services 30 even though both packages are overridden. These two literal
// overrides are the narrow workaround; equality with the catalog keeps the
// catalog authoritative, and validate-lockfile additionally proves one resolved
// runtime copy.
const literalCatalogPeerOverridePins = new Set(["@oxyhq/core", "@oxyhq/services"]);
const workspaceManifestPaths = ["package.json"];
for (const entry of await readdir(resolve(repositoryRoot, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = `packages/${entry.name}/package.json`;
  if (existsSync(resolve(repositoryRoot, manifestPath))) workspaceManifestPaths.push(manifestPath);
}

for (const manifestPath of workspaceManifestPaths) {
  const manifest = await readJson(manifestPath);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(manifest[section] || {})) {
      if (catalog[name] === undefined || range === CATALOG_REFERENCE) continue;
      failures.push(
        `${manifestPath} ${section}.${name} is pinned to "${range}" while workspaces.catalog owns that version; ` +
          `use "${CATALOG_REFERENCE}".`,
      );
    }
  }
}

for (const [name, range] of Object.entries(rootManifest.overrides || {})) {
  if (catalog[name] === undefined || range === CATALOG_REFERENCE) continue;
  if (literalCatalogPeerOverridePins.has(name) && range === catalog[name]) continue;
  failures.push(
    `package.json overrides.${name} is pinned to "${range}" while workspaces.catalog owns that version; ` +
      `use "${CATALOG_REFERENCE}".`,
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
