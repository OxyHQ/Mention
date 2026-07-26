import * as fs from 'node:fs';
import * as path from 'node:path';

const FRONTEND_ROOT = path.resolve(__dirname, '../..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set([
  '__tests__',
  'coverage',
  'node_modules',
  '.expo',
]);

function runtimeSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeSourceFiles(absolutePath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('frontend cache and environment boundaries', () => {
  const sourceFiles = runtimeSourceFiles(FRONTEND_ROOT);

  it('does not define ad hoc React Query array literals outside the factory', () => {
    const offenders = sourceFiles.flatMap((file) => {
      if (file.endsWith(path.join('lib', 'viewerQueryKeys.ts'))) return [];
      const source = withoutComments(fs.readFileSync(file, 'utf8'));
      const hasLiteralQueryKey = /\bqueryKey\s*:\s*\[/.test(source);
      const hasLiteralKeyVariable =
        /\b(?:const|let)\s+\w*(?:QueryKey|queryKey)\s*=\s*(?:useMemo\([\s\S]{0,80}?=>\s*)?\[/.test(
          source,
        );
      return hasLiteralQueryKey || hasLiteralKeyVariable
        ? [path.relative(FRONTEND_ROOT, file)]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  it('keeps runtime process.env reads inside typed config', () => {
    const offenders = sourceFiles.flatMap((file) => {
      if (file === path.join(FRONTEND_ROOT, 'config.ts')) return [];
      return /\bprocess\.env\b/.test(fs.readFileSync(file, 'utf8'))
        ? [path.relative(FRONTEND_ROOT, file)]
        : [];
    });

    expect(offenders).toEqual([]);
  });
});
