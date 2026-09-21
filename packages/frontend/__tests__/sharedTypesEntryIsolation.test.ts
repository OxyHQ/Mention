import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const frontendRoot = path.resolve(__dirname, '..');

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name.startsWith('.')
        || /^(node_modules|dist.*|__tests__|__fixtures__)$/.test(entry.name)
        ? [] : sourceFiles(filename);
    }
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [filename] : [];
  });
}

function retainsRootImport(source: string, filename: string): boolean {
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  });
  const compiled = ts.createSourceFile(filename, outputText, ts.ScriptTarget.Latest);
  return compiled.statements.some((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
    && statement.moduleSpecifier
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === '@mention/shared-types',
  );
}

describe('shared-types frontend runtime boundary', () => {
  it('distinguishes erased types from a runtime root-barrel dependency', () => {
    expect(retainsRootImport(
      "import type { HydratedPost } from '@mention/shared-types'; export type Post = HydratedPost;",
      'types.ts',
    )).toBe(false);
    expect(retainsRootImport(
      "import { PostVisibility } from '@mention/shared-types'; export const visibility = PostVisibility;",
      'runtime.ts',
    )).toBe(true);
    expect(retainsRootImport(
      "import { PostVisibility } from '@mention/shared-types/post'; export const visibility = PostVisibility;",
      'leaf.ts',
    )).toBe(false);
  });

  it('keeps protocol schemas and their second Zod runtime out of frontend entry imports', () => {
    const candidates = sourceFiles(frontendRoot).filter((filename) =>
      /['"]@mention\/shared-types['"]/.test(fs.readFileSync(filename, 'utf8')),
    );
    expect(candidates.length).toBeGreaterThan(50);
    const runtimeRoots = candidates.filter((filename) =>
      retainsRootImport(fs.readFileSync(filename, 'utf8'), filename),
    ).map((filename) => path.relative(frontendRoot, filename));
    expect(runtimeRoots).toEqual([]);
  });
});
