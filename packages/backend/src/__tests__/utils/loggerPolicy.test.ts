import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { CallExpression, Node, SourceFile } from 'typescript/unstable/ast';
import {
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isStringLiteral,
  isTemplateExpression,
} from 'typescript/unstable/ast/is';
import { API, type Program } from 'typescript/unstable/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const SOURCE_ROOT = path.join(BACKEND_ROOT, 'src');
const SERVER_ENTRY = path.join(BACKEND_ROOT, 'server.ts');
const LOGGER_METHODS = new Set(['debug', 'error', 'info', 'warn']);
const SENSITIVE_IDENTIFIER = /(?:^|_)(?:id|ids|did|uri|uris|url|urls|href|inbox|room|ip|ipaddress|address|username|handle|email|acct|query|body|params|content|text|message|dbname|mongouri)$|(?:Id|Ids|Did|Uri|Uris|Url|Urls|Href|Inbox|Room|Ip|IpAddress|Address|Username|Handle|Email|Acct|Query|Body|Params|Content|Text|Message|DbName|MongoUri)$/;

// TypeScript 7's `typescript` package exports only its version; the compiler is
// a native binary and the JS surface moved to the `unstable/*` subpaths. So the
// AST for this policy scan comes from a real program opened over the backend's
// own tsconfig rather than from a standalone `createSourceFile` parse.
let api: InstanceType<typeof API>;
let program: Program;

beforeAll(() => {
  api = new API({ cwd: BACKEND_ROOT });
  const configFileName = path.join(BACKEND_ROOT, 'tsconfig.json');
  const project = api
    .updateSnapshot({ openProjects: [configFileName] })
    .getProject(configFileName);
  if (!project) {
    throw new Error(`Could not open a TypeScript project for ${configFileName}`);
  }
  program = project.program;
});

// The API talks to a spawned compiler process; leaving it open hangs the worker.
afterAll(() => {
  api?.close();
});

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

/**
 * Every production file must be reachable in the program. A file that silently
 * fell out would be scanned as zero nodes, which reads exactly like "no
 * violations" — so this throws rather than letting the policy pass vacuously.
 */
function sourceFileFor(file: string): SourceFile {
  const sourceFile = program.getSourceFile(file);
  if (!sourceFile) {
    throw new Error(
      `${path.relative(BACKEND_ROOT, file)} is not in the backend program, so the logging policy cannot be checked against it`,
    );
  }
  return sourceFile;
}

function isLoggerCall(node: Node): node is CallExpression {
  return (
    isCallExpression(node)
    && isPropertyAccessExpression(node.expression)
    && isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'logger'
    && LOGGER_METHODS.has(node.expression.name.text)
  );
}

function containsSensitiveIdentifier(node: Node): boolean {
  let found = false;
  const visit = (child: Node): void => {
    if (
      (isIdentifier(child) || isPrivateIdentifier(child))
      && SENSITIVE_IDENTIFIER.test(child.text)
    ) {
      found = true;
    }
    if (
      isPropertyAccessExpression(child)
      && SENSITIVE_IDENTIFIER.test(child.name.text)
    ) {
      found = true;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function location(file: string, sourceFile: SourceFile, node: Node): string {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `${path.relative(BACKEND_ROOT, file).replaceAll('\\', '/')}:${line}`;
}

describe('backend logging policy', () => {
  it('does not interpolate identifiers, payloads or identity into logger messages', () => {
    const violations: string[] = [];
    const files = [...productionFiles(SOURCE_ROOT), SERVER_ENTRY];
    let loggerCalls = 0;

    for (const file of files) {
      const sourceFile = sourceFileFor(file);

      const visit = (node: Node): void => {
        if (isLoggerCall(node)) {
          loggerCalls += 1;
          const message = node.arguments[0];
          const sensitiveTemplate = (
            message
            && isTemplateExpression(message)
            && message.templateSpans.some((span) =>
              containsSensitiveIdentifier(span.expression),
            )
          );
          const sensitiveConcatenation = (
            message
            && isBinaryExpression(message)
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
        node.forEachChild(visit);
      };
      visit(sourceFile);
    }

    // A guard that matched nothing would report an empty violation list too.
    expect(loggerCalls).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('sanitizes the early console error fallback in server.ts', () => {
    const sourceFile = sourceFileFor(SERVER_ENTRY);
    const violations: string[] = [];
    let calls = 0;

    const visit = (node: Node): void => {
      if (
        isCallExpression(node)
        && isPropertyAccessExpression(node.expression)
        && isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'console'
        && node.expression.name.text === 'error'
      ) {
        calls += 1;
        const payload = node.arguments[1];
        if (
          node.arguments.length !== 2
          || !isStringLiteral(node.arguments[0])
          || !payload
          || !isCallExpression(payload)
          || !isIdentifier(payload.expression)
          || payload.expression.text !== 'sanitizeLogValue'
        ) {
          violations.push(location(SERVER_ENTRY, sourceFile, node));
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);

    expect(calls).toBe(2);
    expect(violations).toEqual([]);
  });
});
