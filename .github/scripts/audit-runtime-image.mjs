#!/usr/bin/env bun

import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const auditRoot = resolve(process.env.AUDIT_ROOT || "/app");
const expectedRuntimeEntry = process.env.EXPECTED_RUNTIME_ENTRY || "";
const expectedWorkspacePackages = new Set(
  (process.env.EXPECTED_WORKSPACE_PACKAGES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const expectedRuntimeCommands = (process.env.EXPECTED_RUNTIME_COMMANDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const failures = [];

function resolveInsideAuditRoot(relativePath, label) {
  if (!relativePath || isAbsolute(relativePath)) {
    failures.push(`${label} must be a non-empty relative path.`);
    return null;
  }

  const resolvedPath = resolve(auditRoot, relativePath);
  const relativePathFromRoot = relative(auditRoot, resolvedPath);
  if (
    relativePathFromRoot === ".." ||
    relativePathFromRoot.startsWith(`..${sep}`)
  ) {
    failures.push(`${label} escapes the image application root.`);
    return null;
  }
  return resolvedPath;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function inspectRuntimeDist(directory) {
  if (!(await pathExists(directory))) return;

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    const relativeEntryPath = relative(auditRoot, entryPath);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        failures.push(`Test directory is present in runtime dist: ${relativeEntryPath}`);
        continue;
      }
      await inspectRuntimeDist(entryPath);
      continue;
    }
    if (
      entry.isFile() &&
      /\.(?:test|spec)\.js(?:\.map)?$/i.test(entry.name)
    ) {
      failures.push(`Test artifact is present in runtime dist: ${relativeEntryPath}`);
    }
  }
}

const effectiveUid = process.getuid?.();
if (!Number.isInteger(effectiveUid) || effectiveUid === 0) {
  failures.push(
    `Runtime audit must execute as a non-root user; effective uid was ${String(effectiveUid)}.`,
  );
}
for (const command of expectedRuntimeCommands) {
  if (!Bun.which(command)) {
    failures.push(`Required runtime command is missing from PATH: ${command}`);
  }
}

const runtimeEntryPath = resolveInsideAuditRoot(
  expectedRuntimeEntry,
  "EXPECTED_RUNTIME_ENTRY",
);
if (runtimeEntryPath && !(await pathExists(runtimeEntryPath))) {
  failures.push(`Runtime entry is missing: ${expectedRuntimeEntry}`);
}

if (expectedWorkspacePackages.size === 0) {
  failures.push("EXPECTED_WORKSPACE_PACKAGES must name the allowed workspaces.");
}

const packagesDirectory = resolve(auditRoot, "packages");
const discoveredWorkspacePackages = new Set();
if (await pathExists(packagesDirectory)) {
  for (const entry of await readdir(packagesDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;

    const manifestPath = resolve(packagesDirectory, entry.name, "package.json");
    if (!(await pathExists(manifestPath))) {
      failures.push(`Unexpected runtime workspace without a manifest: packages/${entry.name}`);
      continue;
    }

    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const packageName = typeof manifest.name === "string" ? manifest.name : "";
      if (!packageName) {
        failures.push(`Runtime workspace has no package name: packages/${entry.name}`);
        continue;
      }
      discoveredWorkspacePackages.add(packageName);
      if (!expectedWorkspacePackages.has(packageName)) {
        failures.push(`Unexpected workspace in final image: ${packageName}`);
      } else {
        await inspectRuntimeDist(
          resolve(packagesDirectory, entry.name, "dist"),
        );
      }
    } catch (error) {
      failures.push(
        `Unable to parse runtime workspace manifest packages/${entry.name}/package.json: ${error.message}`,
      );
    }
  }
} else {
  failures.push("Final image has no /app/packages directory.");
}

for (const packageName of expectedWorkspacePackages) {
  if (!discoveredWorkspacePackages.has(packageName)) {
    failures.push(`Expected runtime workspace is missing: ${packageName}`);
  }
}

const bannedExactPackages = new Set([
  "@mention/frontend",
  "expo",
  "expo-router",
  "jest",
  "nativewind",
  "react-dom",
  "react-native",
  "tailwindcss",
  "typescript",
  "vitest",
]);
const bannedPackagePrefixes = [
  "@expo/",
  "@jest/",
  "@testing-library/",
  // TypeScript 7 ships the compiler as a native binary split across 20
  // per-platform packages under this scope (`@typescript/typescript-linux-x64`
  // and friends), pulled in as optionalDependencies of `typescript`. The exact
  // ban on "typescript" above does not name them, and each one is ~24 MB, so
  // without this prefix a runtime image could carry the compiler's payload
  // while the audit reported the compiler itself absent.
  "@typescript/",
  "@vitest/",
  "expo-",
  "jest-",
  "react-native-",
];
const installedPackageNames = new Set();

function recordPackageNameFromPath(path) {
  const pathParts = relative(auditRoot, path).split(sep);
  const nodeModulesIndex = pathParts.lastIndexOf("node_modules");
  if (nodeModulesIndex < 0 || nodeModulesIndex + 1 >= pathParts.length) return;

  const firstPart = pathParts[nodeModulesIndex + 1];
  if (!firstPart || firstPart === ".bin" || firstPart === ".bun") return;
  if (firstPart.startsWith("@") && nodeModulesIndex + 2 < pathParts.length) {
    installedPackageNames.add(`${firstPart}/${pathParts[nodeModulesIndex + 2]}`);
  } else {
    installedPackageNames.add(firstPart);
  }
}

async function inspectInstalledPackages(directory) {
  if (!(await pathExists(directory))) return;

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    recordPackageNameFromPath(entryPath);

    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await inspectInstalledPackages(entryPath);
      continue;
    }
    if (!entry.isFile() || entry.name !== "package.json") continue;

    try {
      const manifest = JSON.parse(await readFile(entryPath, "utf8"));
      if (typeof manifest.name === "string") {
        installedPackageNames.add(manifest.name);
      }
    } catch (error) {
      failures.push(
        `Unable to parse installed package manifest ${relative(auditRoot, entryPath)}: ${error.message}`,
      );
    }
  }
}

await inspectInstalledPackages(resolve(auditRoot, "node_modules"));

const forbiddenInstalledPackages = [...installedPackageNames]
  .filter(
    (packageName) =>
      bannedExactPackages.has(packageName) ||
      bannedPackagePrefixes.some((prefix) => packageName.startsWith(prefix)),
  )
  .sort();
if (forbiddenInstalledPackages.length > 0) {
  failures.push(
    `Forbidden development/frontend packages are installed: ${forbiddenInstalledPackages.join(", ")}`,
  );
}

if (failures.length > 0) {
  console.error("Runtime image audit failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Runtime image audit passed as uid ${effectiveUid}: ${discoveredWorkspacePackages.size} workspace(s), ${installedPackageNames.size} installed package name(s).`,
);
