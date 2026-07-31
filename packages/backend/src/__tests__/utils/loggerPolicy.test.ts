/**
 * Backend logging policy, enforced over the real AST of every production file.
 *
 * WHY THE PARSE LOOKS LIKE THIS
 *
 * TypeScript 7 removed the compiler API from the package's main export — it now
 * resolves to `lib/version.cjs`, whose whole surface is two version strings — so
 * `ts.createSourceFile` and `ts.forEachChild` are gone. The AST predicates live
 * under `typescript/unstable/ast` and the walking helpers survive as METHODS on
 * the nodes, but TS 7 ships NO standalone "parse this string" entry point: the
 * only way to obtain a parsed `SourceFile` is to open a PROJECT through the API
 * client, which drives the native `tsgo` binary.
 *
 * Hence the synthetic project below. The files are handed to an in-memory
 * filesystem together with a tsconfig that exists only there, so nothing is
 * written to the tree being scanned and the real `tsconfig.json` (which excludes
 * this directory) is left out of it. `noLib` + `noResolve` + `types: []` keep it
 * a pure syntax parse — no lib.d.ts, no module resolution, no type checking,
 * none of which this policy needs.
 *
 * It must be `unstable/async`, NOT `unstable/sync`: the sync client builds its
 * channel from `child.stdout._handle.fd`, a Node internal Bun does not
 * implement, so the sync client passes under Node and fails under Bun.
 *
 * The `unstable/` is TypeScript's own label — TS 7.0 ships no stable
 * programmatic API at all, so this is the supported path rather than a
 * workaround, but it can move in a future release. If it does, the failure is
 * loud: a missing import or a missing method, not a silent pass.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isStringLiteral,
  isTemplateExpression,
  type CallExpression,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/async';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const SOURCE_ROOT = path.join(BACKEND_ROOT, 'src');
const SERVER_FILE = path.join(BACKEND_ROOT, 'server.ts');
const LOGGER_METHODS = new Set(['debug', 'error', 'info', 'warn']);
const SENSITIVE_IDENTIFIER = /(?:^|_)(?:id|ids|did|uri|uris|url|urls|href|inbox|room|ip|ipaddress|address|username|handle|email|acct|query|body|params|content|text|message|dbname|mongouri)$|(?:Id|Ids|Did|Uri|Uris|Url|Urls|Href|Inbox|Room|Ip|IpAddress|Address|Username|Handle|Email|Acct|Query|Body|Params|Content|Text|Message|DbName|MongoUri)$/;

/**
 * Floor on the directory walk. The policy is only as good as the file list it
 * runs over, and a walk that silently returns a handful of files would report a
 * clean pass forever. The tree holds several hundred; this is well below that
 * and well above anything a broken walk would produce.
 */
const MINIMUM_SCANNED_FILES = 200;

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
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return `${path.relative(BACKEND_ROOT, file).replaceAll('\\', '/')}:${line}`;
}

let api: API | undefined;
/** Every production file, parsed once and shared by the cases below. */
const parsed = new Map<string, SourceFile>();

beforeAll(async () => {
  const files = [...productionFiles(SOURCE_ROOT), SERVER_FILE];
  const virtualConfigPath = path.join(BACKEND_ROOT, 'logger-policy.tsconfig.json');

  api = new API({
    cwd: BACKEND_ROOT,
    fs: createVirtualFileSystem({
      ...Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')])),
      // `files` rather than `include`: the walk above decides what is checked,
      // not TypeScript's globbing.
      [virtualConfigPath]: JSON.stringify({
        compilerOptions: { noEmit: true, noLib: true, noResolve: true, types: [] },
        files,
      }),
    }),
  });

  const snapshot = await api.updateSnapshot({ openProjects: [virtualConfigPath] });
  const program = snapshot.getProjects()[0]?.program;
  if (!program) {
    throw new Error(`Could not open a program over ${files.length} backend source files.`);
  }

  for (const file of files) {
    const source = await program.getSourceFile(file);
    if (!source) {
      throw new Error(`${path.relative(BACKEND_ROOT, file)} never reached the parser.`);
    }
    parsed.set(file, source);
  }
}, 120_000);

// The API holds a spawned `tsgo` process; without this the run keeps the event
// loop alive after the last assertion.
afterAll(async () => {
  await api?.close();
});

describe('backend logging policy', () => {
  it('does not interpolate identifiers, payloads or identity into logger messages', () => {
    expect(parsed.size).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES);

    const violations: string[] = [];

    for (const [file, sourceFile] of parsed) {
      const visit = (node: Node): void => {
        if (isLoggerCall(node)) {
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

    expect(violations).toEqual([]);
  });

  it('sanitizes the early console error fallback in server.ts', () => {
    const sourceFile = parsed.get(SERVER_FILE);
    if (!sourceFile) throw new Error('server.ts was not parsed.');

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
          violations.push(location(SERVER_FILE, sourceFile, node));
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);

    expect(calls).toBe(2);
    expect(violations).toEqual([]);
  });
});
