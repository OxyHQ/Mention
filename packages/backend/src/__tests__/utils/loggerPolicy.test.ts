import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TypeScript from 'typescript';
import { describe, expect, it } from 'vitest';

const ts = createRequire(path.join(__dirname, 'loggerPolicy.test.ts'))(
  'typescript',
) as typeof TypeScript;
const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const SOURCE_ROOT = path.join(BACKEND_ROOT, 'src');
const LOGGER_METHODS = new Set(['debug', 'error', 'info', 'warn']);
const SENSITIVE_IDENTIFIER = /(?:^|_)(?:id|ids|did|uri|uris|url|urls|href|inbox|room|ip|ipaddress|address|username|handle|email|acct|query|body|params|content|text|message|dbname|mongouri)$|(?:Id|Ids|Did|Uri|Uris|Url|Urls|Href|Inbox|Room|Ip|IpAddress|Address|Username|Handle|Email|Acct|Query|Body|Params|Content|Text|Message|DbName|MongoUri)$/;

function productionFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') {
      continue;
    }
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...productionFiles(absolute));
    } else if (absolute.endsWith('.ts') && !absolute.endsWith('.test.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function isLoggerCall(
  node: TypeScript.Node,
): node is TypeScript.CallExpression {
  return (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'logger'
    && LOGGER_METHODS.has(node.expression.name.text)
  );
}

function containsSensitiveIdentifier(node: TypeScript.Node): boolean {
  let found = false;
  const visit = (child: TypeScript.Node): void => {
    if (
      (ts.isIdentifier(child) || ts.isPrivateIdentifier(child))
      && SENSITIVE_IDENTIFIER.test(child.text)
    ) {
      found = true;
    }
    if (
      ts.isPropertyAccessExpression(child)
      && SENSITIVE_IDENTIFIER.test(child.name.text)
    ) {
      found = true;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function location(
  file: string,
  sourceFile: TypeScript.SourceFile,
  node: TypeScript.Node,
): string {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return `${path.relative(BACKEND_ROOT, file).replaceAll('\\', '/')}:${line}`;
}

interface LoggerScan {
  /** `path:line` of every call that leaks. */
  readonly violations: string[];
  /**
   * How many `logger.<method>(…)` calls the visitor RESOLVED.
   *
   * Reported so a caller can tell an empty violation list produced by a clean
   * file apart from one produced by a visitor that resolved nothing at all.
   */
  readonly loggerCalls: number;
}

function scanLoggerCalls(file: string, source: string): LoggerScan {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  let loggerCalls = 0;

  const visit = (node: TypeScript.Node): void => {
    if (isLoggerCall(node)) {
      loggerCalls += 1;
      const message = node.arguments[0];
      const sensitiveTemplate = (
        message
        && ts.isTemplateExpression(message)
        && message.templateSpans.some((span) =>
          containsSensitiveIdentifier(span.expression),
        )
      );
      const sensitiveConcatenation = (
        message
        && ts.isBinaryExpression(message)
        && containsSensitiveIdentifier(message)
      );
      const callText = node.getText(sourceFile);
      const messageText = message?.getText(sourceFile) ?? '';
      if (
        sensitiveTemplate
        || sensitiveConcatenation
        || /JSON\.stringify\s*\(/.test(callText)
        || /\breq\.(?:body|query|params)\b/.test(messageText)
        || /\bsocket\.handshake\.address\b/.test(callText)
        || /\b(?:dbName|mongoUri)\b/.test(callText)
      ) {
        violations.push(location(file, sourceFile, node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { violations, loggerCalls };
}

/**
 * Files the whole-tree walk must reach, and the fact that each one is LOGGING.
 *
 * `expect(violations).toEqual([])` is satisfied identically by a clean tree and
 * by a walk that returned nothing — a renamed `src`, an exclusion widened by
 * one entry, a `productionFiles` that stopped recursing. Two of these are
 * nested several directories deep, so a walk that reaches only the top level
 * cannot meet the floor either.
 */
const REQUIRED_SCANNED_FILES = [
  'server.ts',
  'src/controllers/feed.controller.ts',
  'src/db/postgres.ts',
  'src/services/PostHydrationService.ts',
  'src/services/safety/viewerSafety.ts',
];

/**
 * One case per SHAPE the scanner claims to detect, plus the correct forms it
 * must leave alone.
 *
 * A whole-tree scanner reporting nothing is the same observation whether it
 * works or not, and the detector is where that silence would come from: this
 * file's `SENSITIVE_IDENTIFIER` is a hand-written regex over identifier text
 * and every one of the four textual rules names a construct by spelling. These
 * drive the SAME `scanLoggerCalls` the tree walk does.
 */
const LEAKING_CALLS: readonly { readonly shape: string; readonly source: string }[] = [
  { shape: 'a template interpolating an id', source: 'logger.info(`imported post ${postId}`);' },
  { shape: 'a concatenated actor uri', source: "logger.warn('actor ' + actorUri);" },
  { shape: 'JSON.stringify of a payload', source: "logger.debug('payload', JSON.stringify(payload));" },
  { shape: 'a raw request payload as the message', source: 'logger.error(req.body);' },
  { shape: 'a socket peer address', source: "logger.info('connected', { address: socket.handshake.address });" },
  { shape: 'the database name', source: "logger.info('connected', { dbName });" },
];

const CLEAN_CALLS: readonly { readonly shape: string; readonly source: string }[] = [
  { shape: 'an id passed as CONTEXT, which is the house form', source: "logger.info('user resolved', { userId });" },
  { shape: 'a constant message', source: "logger.debug('sweep complete');" },
  { shape: 'an error passed second', source: "logger.error('failed to load feed', error);" },
];

/**
 * One logger call in, one logger call resolved — otherwise an empty violation
 * list means nothing, for a reason unrelated to the rule under test.
 */
function scanOneCall(source: string): string[] {
  const { violations, loggerCalls } = scanLoggerCalls(
    path.join(BACKEND_ROOT, 'src/detector.control.ts'),
    source,
  );
  expect(loggerCalls).toBe(1);
  return violations;
}

describe('backend logging policy', () => {
  it.each(LEAKING_CALLS)('flags $shape', ({ source }) => {
    expect(scanOneCall(source)).toHaveLength(1);
  });

  it.each(CLEAN_CALLS)('allows $shape', ({ source }) => {
    expect(scanOneCall(source)).toEqual([]);
  });

  it('does not interpolate identifiers, payloads or identity into logger messages', () => {
    const files = [...productionFiles(SOURCE_ROOT), path.join(BACKEND_ROOT, 'server.ts')];
    const scans = files.map((file) => ({
      relative: path.relative(BACKEND_ROOT, file).replaceAll('\\', '/'),
      scan: scanLoggerCalls(file, readFileSync(file, 'utf8')),
    }));

    // FLOOR — the walk reached these files, and each is still a file the
    // scanner has something to say about.
    expect(
      REQUIRED_SCANNED_FILES.filter(
        (required) =>
          !scans.some((entry) => entry.relative === required && entry.scan.loggerCalls > 0),
      ),
    ).toEqual([]);

    expect(scans.flatMap((entry) => entry.scan.violations)).toEqual([]);
    // Whole-tree scanner, not a unit test: it parses EVERY production source
    // file with the TypeScript compiler, so its runtime scales with the
    // codebase and vitest's 5s default was never the right bound. It crossed
    // that bound on CI (~0.5s here, >5s on a shared runner competing with the
    // rest of the suite) and started failing on every commit regardless of
    // content — including a pure revert. The generous ceiling matches the
    // house pattern for slow suites; it is a guard against a hang, not a
    // performance budget.
  }, 60_000);

  it('sanitizes the early console error fallback in the global error handlers', () => {
    // The two `console.error` calls are deliberate: the last-resort handlers must
    // not depend on the logger transport. They live in the runtime module that
    // registers them — `server.ts` only calls `registerGlobalErrorHandlers()`.
    const serverFile = path.join(BACKEND_ROOT, 'src/runtime/globalErrorHandlers.ts');
    const source = readFileSync(serverFile, 'utf8');
    const sourceFile = ts.createSourceFile(
      serverFile,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const violations: string[] = [];
    let calls = 0;

    const visit = (node: TypeScript.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'console'
        && node.expression.name.text === 'error'
      ) {
        calls += 1;
        const payload = node.arguments[1];
        if (
          node.arguments.length !== 2
          || !ts.isStringLiteral(node.arguments[0])
          || !payload
          || !ts.isCallExpression(payload)
          || !ts.isIdentifier(payload.expression)
          || payload.expression.text !== 'sanitizeLogValue'
        ) {
          violations.push(location(serverFile, sourceFile, node));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(calls).toBe(2);
    expect(violations).toEqual([]);
  });
});
