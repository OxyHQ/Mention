#!/usr/bin/env bun

/**
 * Static checks on bun.lock, each of which fails for its own distinct reason so
 * that a failure names its own cause rather than being misread as one of the
 * others:
 *
 *   1. Supply chain — every dependency resolves from the default public registry
 *      over TLS, carries an integrity hash, and is not an alias pointing at a
 *      differently-named package.
 *   2. Workspace records — what the lockfile records for each workspace (path
 *      set, package name, version) matches the manifests on disk. `bun install`
 *      does NOT repair a stale recorded workspace version, so no install-and-diff
 *      check can see this one (~/Oxy/AGENTS.md, "layer 1").
 *   3. Dockerfile manifest coverage — every `bun install --frozen-lockfile` in
 *      an image build has a manifest for every workspace the lockfile records.
 *      Copying 4 of 5 workspace manifests fails with the same
 *      "lockfile had changes, but lockfile is frozen" as a genuinely stale
 *      lockfile, but for an unrelated reason, and only inside the image build —
 *      .github/scripts/verify-lockfile.sh runs against a full checkout and
 *      cannot see it at all.
 *   4. Override-masked range violations — no `overrides` entry forces a package
 *      to a version outside a range some dependent declared, unless that
 *      violation is listed as an accepted one. An override applies to every
 *      edge in the tree at once, so it silences a genuine incompatibility with
 *      the same silence it uses to dedupe a patch: the install stays green,
 *      `--frozen-lockfile` stays green, and the mismatch surfaces at runtime on
 *      a deploy instead. Nothing else here — or in bun — checks this.
 *
 * Intent ported from bluesky-social/social-app 29dad38ab ("Add lockfile lint",
 * MIT (c) 2023-2026 Bluesky Social PBC), which configures `lockfile-lint` with
 * allowedHosts, allowedSchemes, allowedPackageNameAliases, validateIntegrity and
 * validatePackageNames. That package cannot be reused here: lockfile-lint 5.0.0
 * ships a single parser supporting npm and yarn only, and rejects bun.lock
 * outright ("Unable to find relevant lockfile parser for \"bun.lock\""); forcing
 * --type npm or --type yarn gets "Unable to parse <type> lockfile". So the same
 * properties are asserted against bun's own text-lockfile format.
 *
 * Note on upstream's allowedPackageNameAliases: it lists exactly
 * `string-width-cjs`, `strip-ansi-cjs` and `wrap-ansi-cjs`, the same three npm
 * aliases ~/Oxy/AGENTS.md records as false-positive "orphans" in our own trees.
 * None of them appear in Mention's lockfile, so ALLOWED_PACKAGE_NAME_ALIASES
 * starts empty rather than carrying entries nothing can trip.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockfilePath = resolve(repositoryRoot, "bun.lock");
const packagesDirectory = resolve(repositoryRoot, "packages");

/**
 * Hosts a resolution may name. bun leaves this field empty for the default
 * registry and only writes a URL when a scope is pointed somewhere else, so an
 * empty registry field is the norm and any host at all is worth a decision.
 */
const ALLOWED_REGISTRY_HOSTS = ["registry.npmjs.org"];

/**
 * Non-registry resolution protocols. `workspace:` is this monorepo's own
 * packages. A git, tarball, `file:` or `link:` dependency bypasses registry
 * integrity entirely, so each one has to be added here deliberately.
 */
const ALLOWED_NON_REGISTRY_PROTOCOLS = ["workspace:"];

/**
 * Aliases (`"alias": ["real-package@1.0.0", ...]`) that are known and accepted.
 *
 * All three below are `@isaacs/cliui@8`'s own declarations — it depends on the
 * ESM major of each package AND, under a `-cjs` alias, the last CJS major, so it
 * can be required either way. They arrived with `firebase-admin@14` through
 * `google-gax` → `rimraf` → `glob` → `jackspeak`, and each resolves to a
 * registry tarball with integrity like any other dependency; the alias only
 * renames the edge. Nothing here is a second copy admitted by the back door.
 */
const ALLOWED_PACKAGE_NAME_ALIASES = [
  "string-width-cjs:string-width",
  "strip-ansi-cjs:strip-ansi",
  "wrap-ansi-cjs:wrap-ansi",
];

// Bloom 1.x, Services 30 and Core 21 are one compatibility unit. Bun can
// auto-install an older peer under Alia/Syra when their declared range trails
// the Oxy release cadence, even though the root override is authoritative. That
// leaves the bundle able to reach Services code importing removed Bloom APIs.
// Keep this a lockfile property rather than trusting the hoisted package only.
const OXY_RUNTIME_SINGLETONS = ["@oxyhq/bloom", "@oxyhq/core", "@oxyhq/services"];

/**
 * Override-masked range violations that are deliberate, keyed
 * `"<dependent> -> <dependency>@<declared range>"`. The dependent is a package
 * NAME rather than a lockfile key, so an entry survives the tree being
 * reshaped around it; the version actually installed is reported by the failure
 * rather than encoded here, so re-pointing an override at a newer patch does
 * not silently invalidate the reason.
 *
 * Every entry is a decision that the override is worth more than the range it
 * breaks — a security bump the dependent has not caught up with, or a
 * single-copy pin for a native module. An entry that stops firing is reported
 * too, so this cannot rot into a list of claims nothing tests.
 */
const ACCEPTED_OVERRIDE_RANGE_VIOLATIONS = {
      "markdown-it -> linkify-it@^2.0.0":
    "linkify-it is held at one copy for hardened link matching; markdown-it works against the newer API.",
  "@tailwindcss/node -> lightningcss@1.32.0":
    "lightningcss is pinned to 1.30.1 so its linux-x64 gnu/musl native binaries stay on a single version through the image build.",
  "vite -> lightningcss@^1.32.0": "Same single-copy native-binary pin as @tailwindcss/node.",
  "@alia.onl/sdk -> @oxyhq/services@^23.0.1":
    "Peer range on a third-party SDK that trails our release cadence. Forward-compatible: it consumes a stable subset of the services surface.",
};

/**
 * Vacuity floor: a parser that silently produced an empty package map would
 * otherwise pass every assertion below. Current tree resolves 1955 entries.
 */
const MINIMUM_PACKAGES = 1200;

const failures = [];

/**
 * bun.lock is JSON with trailing commas. Stripping them has to respect string
 * literals, or an integrity hash or version range that happens to contain the
 * pattern would be corrupted silently.
 */
function stripTrailingCommas(text) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text[cursor] === '"') break;
        cursor += 1;
      }
      output += text.slice(index, cursor + 1);
      index = cursor + 1;
      continue;
    }
    if (character === ",") {
      const rest = text.slice(index + 1);
      const trailing = /^\s*[}\]]/.exec(rest);
      if (trailing) {
        output += trailing[0];
        index += 1 + trailing[0].length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

/**
 * The chain of package names a bun.lock key encodes. `"@babel/core/debug"` is
 * `debug` as resolved under `@babel/core`, not a package called
 * `@babel/core/debug`, so the leaf is what the entry actually installs.
 */
function resolutionChain(key) {
  const tokens = key.split("/");
  const chain = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].startsWith("@") && index + 1 < tokens.length) {
      chain.push(`${tokens[index]}/${tokens[index + 1]}`);
      index += 1;
    } else {
      chain.push(tokens[index]);
    }
  }
  return chain;
}

/**
 * Splits `@scope/name@spec` into its name and its resolution spec. Splits on the
 * first `@` past any scope rather than the last one, because a spec can contain
 * `@` itself (`git+ssh://git@github.com/...`) and splitting from the right would
 * report the protocol as part of the package name.
 */
function splitDescriptor(descriptor) {
  const scopeEnd = descriptor.startsWith("@") ? descriptor.indexOf("/") : 0;
  const separator = descriptor.indexOf("@", scopeEnd + 1);
  if (separator <= 0) return { name: descriptor, spec: "" };
  return { name: descriptor.slice(0, separator), spec: descriptor.slice(separator + 1) };
}

const source = await readFile(lockfilePath, "utf8");

let lockfile;
try {
  lockfile = JSON.parse(stripTrailingCommas(source));
} catch (error) {
  console.error(`bun.lock could not be parsed: ${error.message}`);
  process.exit(1);
}

// The equivalent of lockfile-lint's `allowedSchemes: ["https:"]`, applied to the
// whole file so a plaintext URL is caught wherever bun decided to record it.
for (const match of source.matchAll(/\bhttp:\/\/[^\s"']+/g)) {
  failures.push(`plaintext URL ${match[0]} — every resolution must use https`);
}

const packages = lockfile.packages;
if (!packages || typeof packages !== "object") {
  console.error("bun.lock has no `packages` map; this is not a bun text lockfile");
  process.exit(1);
}

const packageCount = Object.keys(packages).length;
if (packageCount < MINIMUM_PACKAGES) {
  failures.push(
    `only ${packageCount} resolutions found, below the ${MINIMUM_PACKAGES} floor — the lockfile parser is probably broken`,
  );
}

const rootManifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));

const allowedAliases = new Set(ALLOWED_PACKAGE_NAME_ALIASES);

for (const [key, entry] of Object.entries(packages)) {
  if (!Array.isArray(entry) || typeof entry[0] !== "string") {
    failures.push(`${key}: resolution is not a bun lockfile entry`);
    continue;
  }

  const { name, spec } = splitDescriptor(entry[0]);
  const installed = resolutionChain(key).at(-1);

  if (installed !== name && !allowedAliases.has(`${installed}:${name}`)) {
    failures.push(
      `${key}: resolves to a differently named package (${entry[0]}) — add "${installed}:${name}" to ALLOWED_PACKAGE_NAME_ALIASES if that alias is intended`,
    );
  }

  const protocol = ALLOWED_NON_REGISTRY_PROTOCOLS.find((candidate) => spec.startsWith(candidate));
  if (protocol) continue;

  if (!/^\d/.test(spec)) {
    failures.push(
      `${key}: resolves from "${spec}", which is neither the registry nor an allowed protocol (${ALLOWED_NON_REGISTRY_PROTOCOLS.join(", ")}) — a git, tarball or link dependency has no registry integrity`,
    );
    continue;
  }

  const registry = entry[1];
  if (typeof registry !== "string") {
    failures.push(`${key}: registry field is ${typeof registry}, expected a string`);
  } else if (registry !== "") {
    let host;
    try {
      const url = new URL(registry);
      if (url.protocol !== "https:") {
        failures.push(`${key}: registry ${registry} is not https`);
      }
      host = url.host;
    } catch {
      failures.push(`${key}: registry "${registry}" is not a URL`);
    }
    if (host && !ALLOWED_REGISTRY_HOSTS.includes(host)) {
      failures.push(`${key}: registry host ${host} is not in ALLOWED_REGISTRY_HOSTS`);
    }
  }

  const integrity = entry.at(-1);
  if (typeof integrity !== "string" || !/^sha(?:512|384|256|1)-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    failures.push(`${key}: has no integrity hash, so nothing verifies what gets installed`);
  }
}

let auditedOxyRuntimeSingletons = 0;
for (const packageName of OXY_RUNTIME_SINGLETONS) {
  const resolutions = Object.entries(packages).filter(([key, entry]) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return false;
    return resolutionChain(key).at(-1) === packageName && splitDescriptor(entry[0]).name === packageName;
  });
  auditedOxyRuntimeSingletons += 1;
  if (resolutions.length !== 1) {
    failures.push(
      `${packageName}: expected one Oxy runtime resolution, found ${resolutions.length} (${resolutions.map(([key]) => key).join(", ") || "none"}) — Bloom, Services and Core must move as one compatibility unit`,
    );
    continue;
  }

  const [, [descriptor]] = resolutions[0];
  const installedVersion = splitDescriptor(descriptor).spec;
  const catalogRange = rootManifest.workspaces?.catalog?.[packageName];
  if (typeof catalogRange !== "string" || !semver.satisfies(installedVersion, catalogRange)) {
    failures.push(
      `${packageName}: resolved ${installedVersion}, which does not satisfy its catalog range ${String(catalogRange)}`,
    );
  }

  if (["@oxyhq/core", "@oxyhq/services"].includes(packageName)) {
    const overrideRange = rootManifest.overrides?.[packageName];
    if (overrideRange !== catalogRange) {
      failures.push(
        `${packageName}: Bun peer-deduplication override ${String(overrideRange)} must exactly match catalog ${String(catalogRange)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The workspace records match the manifests on disk.
//
//    `bun install` leaves a stale recorded workspace `version` exactly as it
//    found it and reports no change, so an install-and-diff check — including
//    .github/scripts/verify-lockfile.sh — is blind to this shape. Only deleting
//    the lockfile and resolving from scratch rewrites it, which is not something
//    CI can do (see the note on caret ranges in verify-lockfile.sh).
// ---------------------------------------------------------------------------

const recordedWorkspaces = lockfile.workspaces;
if (!recordedWorkspaces || typeof recordedWorkspaces !== "object") {
  console.error("bun.lock has no `workspaces` map; this is not a bun text lockfile");
  process.exit(1);
}

/** Workspace directories the lockfile claims exist, root (`""`) excluded. */
const workspacePaths = Object.keys(recordedWorkspaces)
  .filter((path) => path !== "")
  .sort();

const onDiskWorkspacePaths = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}`)
  .filter((path) => existsSync(resolve(repositoryRoot, path, "package.json")))
  .sort();

for (const path of onDiskWorkspacePaths) {
  if (workspacePaths.includes(path)) continue;
  failures.push(
    `workspace ${path} has a package.json but bun.lock does not record it — run \`bun install\` so the workspace is resolvable`,
  );
}
for (const path of workspacePaths) {
  if (onDiskWorkspacePaths.includes(path)) continue;
  failures.push(
    `bun.lock records workspace ${path}, which has no package.json on disk — the lockfile is describing a workspace that no longer exists`,
  );
}

for (const [path, recorded] of Object.entries(recordedWorkspaces)) {
  const manifestPath = resolve(repositoryRoot, path, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const location = path === "" ? "package.json" : `${path}/package.json`;

  if (recorded.name !== manifest.name) {
    failures.push(
      `bun.lock records workspace ${path || "(root)"} as "${recorded.name}", but ${location} says "${manifest.name}"`,
    );
  }
  // bun omits `version` for the root workspace, so only compare what it records.
  if (recorded.version !== undefined && recorded.version !== manifest.version) {
    failures.push(
      `bun.lock records ${location} at version ${recorded.version}, but the manifest says ${manifest.version} — \`bun install\` does not repair this; delete bun.lock and reinstall`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Every frozen install in an image build can see every workspace manifest.
// ---------------------------------------------------------------------------

/**
 * A Dockerfile as logical instructions, with continuations joined and comments
 * dropped, so a `RUN` spanning four physical lines is one instruction and still
 * reports the line it started on.
 */
function parseDockerfile(source) {
  const instructions = [];
  let text = "";
  let startLine = 0;
  let lineNumber = 0;
  for (const line of source.split("\n")) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (text === "") startLine = lineNumber;
    const continued = trimmed.endsWith("\\");
    text += (text === "" ? "" : " ") + (continued ? trimmed.slice(0, -1).trim() : trimmed);
    if (!continued) {
      instructions.push({ text, line: startLine });
      text = "";
    }
  }
  if (text !== "") instructions.push({ text, line: startLine });
  return instructions;
}

/** The workspaces whose package.json a single COPY makes available. */
function workspacesCoveredByCopy(argumentText, candidates) {
  const tokens = argumentText.split(/\s+/).filter((token) => token !== "" && !token.startsWith("--"));
  // The final token is the destination; everything before it is a source.
  const sources = tokens.slice(0, -1).map((source) => source.replace(/^\/app\//, "").replace(/^\.\//, ""));

  const covered = [];
  for (const workspace of candidates) {
    for (const source of sources) {
      const manifest = `${workspace}/package.json`;
      const wholeDirectory = source === workspace || source === `${workspace}/`;
      const glob =
        source.includes("*") &&
        new RegExp(`^${source.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(manifest);
      if (source === manifest || wholeDirectory || glob) {
        covered.push(workspace);
        break;
      }
    }
  }
  return covered;
}

const dockerfileNames = (await readdir(packagesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}/Dockerfile`)
  .filter((path) => existsSync(resolve(repositoryRoot, path)))
  .sort();

if (dockerfileNames.length === 0) {
  failures.push("no Dockerfiles found under packages/ — the Dockerfile scan is probably broken");
}

let auditedInstalls = 0;
for (const dockerfileName of dockerfileNames) {
  const coverageByStage = new Map();
  let stage = null;

  for (const { text, line } of parseDockerfile(await readFile(resolve(repositoryRoot, dockerfileName), "utf8"))) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(text);
    if (from) {
      // `FROM <earlier stage>` inherits that stage's filesystem, manifests included.
      const inherited = coverageByStage.get(from[1]);
      stage = { name: from[2] ?? `${dockerfileName}:${line}`, covered: new Set(inherited ?? []) };
      coverageByStage.set(stage.name, stage.covered);
      continue;
    }
    if (!stage) continue;

    const copy = /^COPY\s+(.+)$/i.exec(text);
    if (copy) {
      for (const workspace of workspacesCoveredByCopy(copy[1], workspacePaths)) stage.covered.add(workspace);
      continue;
    }

    if (!/^RUN\b/i.test(text) || !/\bbun\s+install\b/.test(text) || !text.includes("--frozen-lockfile")) {
      continue;
    }

    auditedInstalls += 1;
    const missing = workspacePaths.filter((workspace) => !stage.covered.has(workspace));
    if (missing.length === 0) continue;
    failures.push(
      `${dockerfileName}:${line}: \`bun install --frozen-lockfile\` runs in stage "${stage.name}" without a manifest for ${missing.join(", ")}. bun.lock records ${workspacePaths.length} workspaces and a frozen install needs all of them, so this fails with "lockfile had changes, but lockfile is frozen" inside the image build even though the lockfile is correct. Add \`COPY ${missing[0]}/package.json ${missing[0]}/\` before this RUN.`,
    );
  }
}

if (auditedInstalls === 0) {
  failures.push(
    "no frozen `bun install` found in any Dockerfile — the instruction parser is probably broken",
  );
}

// ---------------------------------------------------------------------------
// 4. No override forces a package outside a range someone declared.
//
//    `overrides` exists to collapse a package to a single copy. It does that by
//    outranking every declared range at once, which means it cannot tell the
//    difference between deduping a patch and satisfying a range the dependent
//    never claimed to support. Both installs are green, so the second case has
//    nowhere to surface but production.
// ---------------------------------------------------------------------------

const overriddenPackages = new Set(Object.keys(rootManifest.overrides ?? {}));
if (overriddenPackages.size === 0) {
  failures.push("root package.json declares no overrides — the override scan is probably broken");
}

/**
 * The entry a dependency edge resolves to, following bun's rule that the
 * nearest enclosing scope wins: a dep of `a/b` is `a/b/dep`, else `a/dep`,
 * else the hoisted `dep`.
 */
function resolveEdge(fromKey, dependencyName) {
  const enclosing = fromKey === "" ? [] : resolutionChain(fromKey);
  for (let depth = enclosing.length; depth >= 0; depth -= 1) {
    const candidate = [...enclosing.slice(0, depth), dependencyName].join("/");
    if (packages[candidate]) return packages[candidate];
  }
  return null;
}

const firedViolations = new Set();
let auditedOverrideEdges = 0;

for (const [key, entry] of Object.entries(packages)) {
  if (!Array.isArray(entry)) continue;
  const metadata = entry.find((field) => field && typeof field === "object" && !Array.isArray(field));
  if (!metadata) continue;
  const dependent = resolutionChain(key).at(-1);

  for (const field of ["dependencies", "peerDependencies"]) {
    for (const [dependency, range] of Object.entries(metadata[field] ?? {})) {
      if (!overriddenPackages.has(dependency) || typeof range !== "string") continue;
      // An optional peer is a capability the dependent runs without.
      if (field === "peerDependencies" && (metadata.optionalPeers ?? []).includes(dependency)) continue;
      // `workspace:`, `npm:` and `catalog:` specs are not version ranges.
      if (!semver.validRange(range)) continue;

      const resolved = resolveEdge(key, dependency);
      if (!Array.isArray(resolved) || typeof resolved[0] !== "string") continue;
      const { name, spec } = splitDescriptor(resolved[0]);
      if (name !== dependency || !semver.valid(spec)) continue;

      auditedOverrideEdges += 1;
      if (semver.satisfies(spec, range)) continue;

      const violation = `${dependent} -> ${dependency}@${range}`;
      firedViolations.add(violation);
      if (violation in ACCEPTED_OVERRIDE_RANGE_VIOLATIONS) continue;
      failures.push(
        `${key}: declares ${dependency}@${range} (${field}) but the "${dependency}" override installs ${spec}, which does not satisfy it. ` +
          `Nothing fails at install time — bun applies the override and \`--frozen-lockfile\` stays green — so this only shows up once the missing version's behaviour is reached at runtime. ` +
          `Either point the override at a version the range accepts, upgrade ${dependent}, or record it in ACCEPTED_OVERRIDE_RANGE_VIOLATIONS as "${violation}" with the reason it is safe.`,
      );
    }
  }
}

if (auditedOverrideEdges === 0) {
  failures.push(
    "no overridden dependency edge was resolved — the override scan matched nothing and would pass regardless of the tree",
  );
}

for (const violation of Object.keys(ACCEPTED_OVERRIDE_RANGE_VIOLATIONS)) {
  if (firedViolations.has(violation)) continue;
  failures.push(
    `ACCEPTED_OVERRIDE_RANGE_VIOLATIONS lists "${violation}", which no longer happens — the override or the dependent moved. Delete the entry so the list keeps describing the tree.`,
  );
}

if (failures.length > 0) {
  console.error("bun.lock validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("");
  process.exit(1);
}

console.log(
  `Validated ${packageCount} bun.lock resolutions (registry-only, https, integrity-pinned, no aliases), ` +
    `${workspacePaths.length} workspace records against their manifests, ` +
    `${auditedInstalls} frozen installs across ${dockerfileNames.length} Dockerfiles, and ` +
    `${auditedOverrideEdges} edges against the ${overriddenPackages.size} overridden packages ` +
    `(${firedViolations.size} accepted range violations); ${auditedOxyRuntimeSingletons} Oxy runtime singletons.`,
);
