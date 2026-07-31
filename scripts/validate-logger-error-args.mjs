#!/usr/bin/env bun

/**
 * Rejects `logger.error(message, { … })` for loggers that come from
 * `@oxyhq/core/logger`.
 *
 * That SDK signature is `error(message, error?, context?)` — the SECOND
 * argument is the error itself, and the THIRD is context. Passing a wrapper
 * object as the second argument compiles cleanly (the parameter is `unknown`)
 * and puts a plain object where the error belongs, so the sink's error handling
 * never sees an error. Nothing at runtime complains; the entry is just poorer
 * than it looks.
 *
 * WHY THIS IS SCOPED, AND MUST STAY SCOPED
 *
 * The SAME call shape is CORRECT in `packages/backend`, which uses its own pino
 * wrapper (`packages/backend/src/utils/logger.ts`). Its signature reads
 * identically — `error(message: string, error?: unknown)` — but its body
 * branches: an `Error` becomes pino's `{ err }`, and anything else is merged as
 * pino context. There are well over a hundred deliberate
 * `logger.error(msg, { userId, error })` calls there.
 *
 * So the distinguishing fact is not in either signature — it is in the body of a
 * function nobody reads, and two loggers assign opposite meanings to the same
 * argument. An unscoped version of this check fires on every correct backend
 * call, and a gate that cries wolf gets disabled by whoever hits it next. Hence
 * the import-based scope: a file is only checked when it actually imports the
 * SDK logger.
 *
 * `debug` / `info` / `warn` are deliberately NOT checked: their second parameter
 * genuinely IS `LogContext`, so an object literal there is right. The same
 * shape is correct one line above and wrong one line below.
 *
 * WHY THE PARSE LOOKS LIKE THIS
 *
 * TypeScript 7 removed the compiler API from the package's main export — it now
 * resolves to `lib/version.cjs`, so `import ts from "typescript"` yields two
 * version keys and nothing else, and `ts.createSourceFile` / `ts.forEachChild`
 * are simply gone. The AST predicates and the node methods survive under
 * `typescript/unstable/*`, but there is no standalone "parse this string"
 * entry point any more: the only way to obtain a parsed `SourceFile` is to open
 * a PROJECT through the API client, which drives the native `tsgo` binary.
 *
 * Hence the synthetic project below. The files this validator wants are handed
 * to an in-memory filesystem together with a tsconfig that exists only there —
 * nothing is written to the tree being scanned, which matters because
 * `LOGGER_VALIDATOR_ROOT` points at a bare fixture directory with no tsconfig of
 * its own. `noLib` + `noResolve` + `types: []` keep it a pure syntax parse: no
 * lib.d.ts, no module resolution, no type checking, none of which this check
 * needs. It stays fast (a few milliseconds) because the program is exactly the
 * handful of files that name the SDK logger, not a real compilation.
 *
 * The `unstable/` in those specifiers is TypeScript's own label and is worth
 * knowing about: TS 7.0 ships no stable programmatic API at all, so this is the
 * supported path rather than a workaround, but it can move in a future release.
 * If it does, the failure will be loud (an import or a missing method), and
 * `test-validate-logger-error-args.mjs` covers the behaviour either way.
 *
 * It must be `unstable/async`, NOT `unstable/sync`, because this repo runs its
 * scripts under Bun. The sync client talks to `tsgo` over a synchronous channel
 * built from `child.stdout._handle.fd` — a Node internal Bun does not implement,
 * so constructing the sync `API` throws `undefined is not an object` before any
 * work happens. The async client uses ordinary streams and runs on both. Verify
 * any change here under `bun`, not just `node`: the sync version passes cleanly
 * under Node and fails on every case under Bun.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclaration,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";

/**
 * The tree to scan. Overridable so the validator's own tests can point it at a
 * scratch checkout — they need it to resolve `typescript` from THIS repo while
 * reading files from somewhere else.
 */
const repositoryRoot = process.env.LOGGER_VALIDATOR_ROOT
  ? resolve(process.env.LOGGER_VALIDATOR_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The module whose `error()` puts the error in the second argument. */
const SDK_LOGGER_MODULE = "@oxyhq/core/logger";

/** Package source roots that may import the SDK logger. */
const SOURCE_ROOTS = [
  "packages/frontend",
  "packages/backend/src",
  "packages/mcp/src",
  "packages/shared-types/src",
];

const SOURCE_EXTENSIONS = /\.(?:tsx?|jsx?)$/;
const EXCLUDED_PATH =
  /(?:^|\/)(?:node_modules|dist|\.expo|android|ios|__mocks__)(?:\/|$)/;

/**
 * Vacuity floors. A traversal that quietly stops finding files, or an import
 * matcher broken by a rename, would otherwise report a clean run forever — the
 * exact failure this check exists to prevent, turned on itself.
 */
const MINIMUM_SCANNED_FILES = 400;
const MINIMUM_LOGGER_FILES = 20;

async function collectSourceFiles(directory, collected) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (EXCLUDED_PATH.test(relative(repositoryRoot, path))) continue;
    if (entry.isDirectory()) {
      await collectSourceFiles(path, collected);
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      collected.push(path);
    }
  }
  return collected;
}

/**
 * The identifiers in `source` that hold an SDK logger: the names imported from
 * `@oxyhq/core/logger`, plus anything assigned from a `createLogger(...)` /
 * `.child(...)` call on one of them.
 */
function sdkLoggerIdentifiers(source) {
  const imported = new Set();
  const factories = new Set();

  for (const statement of source.statements) {
    if (
      !isImportDeclaration(statement)
      || !isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== SDK_LOGGER_MODULE
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const originalName = (element.propertyName ?? element.name).text;
        if (originalName === "createLogger") {
          factories.add(element.name.text);
        } else {
          imported.add(element.name.text);
        }
      }
    }
  }

  if (imported.size === 0 && factories.size === 0) return imported;

  // `const log = createLogger('x')` and `const child = log.child('y')` are
  // loggers too, and are how most call sites actually get one.
  const visit = (node) => {
    if (
      isVariableDeclaration(node)
      && isIdentifier(node.name)
      && node.initializer
      && isCallExpression(node.initializer)
    ) {
      const callee = node.initializer.expression;
      if (isIdentifier(callee) && factories.has(callee.text)) {
        imported.add(node.name.text);
      } else if (
        isPropertyAccessExpression(callee)
        && callee.name.text === "child"
        && isIdentifier(callee.expression)
        && imported.has(callee.expression.text)
      ) {
        imported.add(node.name.text);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  return imported;
}

/** Every `<sdkLogger>.error(msg, { … })` in `source`. */
function offendingCalls(source, loggerNames) {
  const offences = [];
  const visit = (node) => {
    if (
      isCallExpression(node)
      && isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "error"
      && isIdentifier(node.expression.expression)
      && loggerNames.has(node.expression.expression.text)
      && node.arguments.length >= 2
      && isObjectLiteralExpression(node.arguments[1])
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      offences.push({
        line: line + 1,
        logger: node.expression.expression.text,
        text: node.getText(source).split("\n")[0].trim(),
      });
    }
    node.forEachChild(visit);
  };
  visit(source);
  return offences;
}

const failures = [];
const scannedFiles = [];
const loggerFiles = [];

for (const root of SOURCE_ROOTS) {
  await collectSourceFiles(resolve(repositoryRoot, root), scannedFiles);
}

// Cheap pre-filter: parsing is the slow part, and a file that never names the
// module cannot import from it. Only the survivors reach the parser.
const candidates = [];
for (const path of scannedFiles) {
  const contents = await readFile(path, "utf8");
  if (contents.includes(SDK_LOGGER_MODULE)) candidates.push([path, contents]);
}

/**
 * The candidates as a syntax-only program. The tsconfig lives in the in-memory
 * filesystem beside them, so the scanned tree is never written to. `files`
 * rather than `include` keeps the program to exactly what was collected — the
 * directory walk above, not TypeScript's globbing, decides what is checked.
 */
const virtualConfigPath = join(repositoryRoot, "logger-validator.tsconfig.json");
const api = new API({
  cwd: repositoryRoot,
  fs: createVirtualFileSystem({
    ...Object.fromEntries(candidates),
    [virtualConfigPath]: JSON.stringify({
      compilerOptions: {
        allowJs: true,
        jsx: "preserve",
        noEmit: true,
        noLib: true,
        noResolve: true,
        types: [],
      },
      files: candidates.map(([path]) => path),
    }),
  }),
});
const snapshot = await api.updateSnapshot({ openProjects: [virtualConfigPath] });
const program = (await snapshot.getProjects())[0]?.program;
if (!program) {
  console.error(`The validator could not open a program over ${candidates.length} candidate files.`);
  process.exit(1);
}

for (const [path] of candidates) {
  const source = await program.getSourceFile(path);
  if (!source) {
    failures.push(`${relative(repositoryRoot, path)}: names ${SDK_LOGGER_MODULE} but never reached the parser`);
    continue;
  }

  const loggerNames = sdkLoggerIdentifiers(source);
  if (loggerNames.size === 0) continue;
  loggerFiles.push(path);

  for (const offence of offendingCalls(source, loggerNames)) {
    failures.push(
      `${relative(repositoryRoot, path)}:${offence.line}: `
      + `\`${offence.logger}.error\` takes the error SECOND, not a context object — `
      + `write \`${offence.logger}.error(message, error)\` (context goes third).\n`
      + `    ${offence.text}`,
    );
  }
}

// The API holds a spawned `tsgo` process; without this the script keeps the
// event loop alive after it has said everything it has to say.
api.close();

if (scannedFiles.length < MINIMUM_SCANNED_FILES) {
  failures.push(
    `${scannedFiles.length} source files scanned is below the ${MINIMUM_SCANNED_FILES} floor — the directory walk is probably broken`,
  );
}

if (loggerFiles.length < MINIMUM_LOGGER_FILES) {
  failures.push(
    `${loggerFiles.length} files import ${SDK_LOGGER_MODULE}, below the ${MINIMUM_LOGGER_FILES} floor — the import matcher is probably broken`,
  );
}

if (failures.length > 0) {
  console.error("Logger argument validation failed:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}

console.log(
  `Logger argument validation passed — ${loggerFiles.length} files import ${SDK_LOGGER_MODULE}, `
  + `of ${scannedFiles.length} scanned.`,
);
