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
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== SDK_LOGGER_MODULE
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
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
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
    ) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && factories.has(callee.text)) {
        imported.add(node.name.text);
      } else if (
        ts.isPropertyAccessExpression(callee)
        && callee.name.text === "child"
        && ts.isIdentifier(callee.expression)
        && imported.has(callee.expression.text)
      ) {
        imported.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return imported;
}

/** Every `<sdkLogger>.error(msg, { … })` in `source`. */
function offendingCalls(source, loggerNames) {
  const offences = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "error"
      && ts.isIdentifier(node.expression.expression)
      && loggerNames.has(node.expression.expression.text)
      && node.arguments.length >= 2
      && ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      offences.push({
        line: line + 1,
        logger: node.expression.expression.text,
        text: node.getText(source).split("\n")[0].trim(),
      });
    }
    ts.forEachChild(node, visit);
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

for (const path of scannedFiles) {
  const contents = await readFile(path, "utf8");
  // Cheap pre-filter: parsing every file is the slow part, and a file that
  // never names the module cannot import from it.
  if (!contents.includes(SDK_LOGGER_MODULE)) continue;

  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
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
