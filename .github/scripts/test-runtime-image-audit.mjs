#!/usr/bin/env bun

import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const auditScript = resolve(
  repositoryRoot,
  ".github/scripts/audit-runtime-image.mjs",
);
const fixtureRoot = await mkdtemp("/tmp/mention-runtime-audit-");

async function writeJson(relativePath, value) {
  const outputPath = resolve(fixtureRoot, relativePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value)}\n`);
}

async function runAudit(
  expectedSuccess,
  expectedMessage = "",
  extraEnvironment = {},
) {
  const child = Bun.spawnSync({
    cmd: [process.execPath, auditScript],
    env: {
      ...process.env,
      AUDIT_ROOT: fixtureRoot,
      EXPECTED_RUNTIME_ENTRY: "packages/backend/dist/server.js",
      EXPECTED_WORKSPACE_PACKAGES:
        "@mention/backend,@mention/shared-types",
      ...extraEnvironment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${child.stdout.toString()}${child.stderr.toString()}`;

  if ((child.exitCode === 0) !== expectedSuccess) {
    throw new Error(
      `Runtime image audit had unexpected exit code ${child.exitCode}:\n${output}`,
    );
  }
  if (expectedMessage && !output.includes(expectedMessage)) {
    throw new Error(
      `Runtime image audit output did not include ${JSON.stringify(expectedMessage)}:\n${output}`,
    );
  }
}

try {
  await writeJson("packages/backend/package.json", {
    name: "@mention/backend",
  });
  await writeJson("packages/shared-types/package.json", {
    name: "@mention/shared-types",
  });
  await mkdir(resolve(fixtureRoot, "packages/backend/dist"), {
    recursive: true,
  });
  await writeFile(
    resolve(fixtureRoot, "packages/backend/dist/server.js"),
    "export {};\n",
  );
  await writeJson("node_modules/express/package.json", { name: "express" });

  await runAudit(true, "Runtime image audit passed");
  await runAudit(
    false,
    "Required runtime command is missing from PATH: mention-missing-command",
    { EXPECTED_RUNTIME_COMMANDS: "bun,mention-missing-command" },
  );

  await writeJson("node_modules/typescript/package.json", {
    name: "typescript",
  });
  await runAudit(
    false,
    "Forbidden development/frontend packages are installed: typescript",
  );
  await rm(resolve(fixtureRoot, "node_modules/typescript"), {
    recursive: true,
  });

  await writeFile(
    resolve(fixtureRoot, "packages/backend/dist/query.spec.js"),
    "export {};\n",
  );
  await runAudit(
    false,
    "Test artifact is present in runtime dist: packages/backend/dist/query.spec.js",
  );
  await rm(resolve(fixtureRoot, "packages/backend/dist/query.spec.js"));

  await writeJson(
    "packages/backend/dist/services/__tests__/service.test.js",
    {},
  );
  await runAudit(
    false,
    "Test directory is present in runtime dist: packages/backend/dist/services/__tests__",
  );
  await rm(resolve(fixtureRoot, "packages/backend/dist/services"), {
    recursive: true,
  });

  await writeJson("packages/frontend/package.json", {
    name: "@mention/frontend",
  });
  await runAudit(false, "Unexpected workspace in final image: @mention/frontend");

  console.log("Runtime image audit fixture tests passed.");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
