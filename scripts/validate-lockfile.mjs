#!/usr/bin/env bun

/**
 * Supply-chain lint for bun.lock: every dependency resolves from the default
 * public registry over TLS, carries an integrity hash, and is not an alias
 * pointing at a differently-named package.
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

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockfilePath = resolve(repositoryRoot, "bun.lock");

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

/** Aliases (`"alias": ["real-package@1.0.0", ...]`) that are known and accepted. */
const ALLOWED_PACKAGE_NAME_ALIASES = [];

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

if (failures.length > 0) {
  console.error("bun.lock validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("");
  process.exit(1);
}

console.log(
  `Validated ${packageCount} bun.lock resolutions: registry-only, https, integrity-pinned, no package-name aliases.`,
);
