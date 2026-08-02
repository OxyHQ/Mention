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

describe('backend logging policy', () => {
  it('does not interpolate identifiers, payloads or identity into logger messages', () => {
    const violations: string[] = [];
    const files = [...productionFiles(SOURCE_ROOT), path.join(BACKEND_ROOT, 'server.ts')];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );

      const visit = (node: TypeScript.Node): void => {
        if (isLoggerCall(node)) {
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
    }

    expect(violations).toEqual([]);
    // Whole-tree scanner, not a unit test: it parses EVERY production source
    // file with the TypeScript compiler, so its runtime scales with the
    // codebase and vitest's 5s default was never the right bound. It crossed
    // that bound on CI (~0.5s here, >5s on a shared runner competing with the
    // rest of the suite) and started failing on every commit regardless of
    // content — including a pure revert. The generous ceiling matches the
    // house pattern for slow suites; it is a guard against a hang, not a
    // performance budget.
  }, 60_000);

  it('sanitizes the early console error fallback in server.ts', () => {
    const serverFile = path.join(BACKEND_ROOT, 'server.ts');
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
