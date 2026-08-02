/**
 * The Mongoose models this port has DELETED, read back out of git history.
 *
 * ## Why the working tree stops being the source of truth
 *
 * Production runs `main`, where every model still exists. This branch deletes
 * each one as its collection is ported — so a vocabulary can lose its referent
 * in the tree while the backfill still reads that collection out of the live
 * database. A check that consults only the tree therefore loses coverage **as
 * the port succeeds**, silently, one model at a time, and reports green the
 * whole way down. That is the same shape as a gate that starts passing because
 * the thing it measured stopped existing.
 *
 * The alternative — a hand-maintained list of "collections whose model is gone,
 * verified by hand at the time" — was written first and rejected. It rots in
 * the direction nobody notices: an entry records that SOMEBODY once checked,
 * which is not the same as a check, and it goes stale the moment the vocabulary
 * it exempts is edited. Git already holds the deleted file, immutably, so the
 * comparison can simply keep running.
 *
 * ## How
 *
 * `git log --diff-filter=D` names every commit that deleted a model file;
 * the newest deletion per path wins. The blob at `<commit>^:<path>` is
 * materialised into a scratch directory **directly under `src/`** and imported,
 * which lets Mongoose parse the schema rather than a regex — the whole point,
 * since half of these vocabularies live inside arrays of subdocuments that no
 * flat parse would find.
 *
 * The scratch directory's depth is load-bearing and is the reason it is not in
 * `os.tmpdir()`: `src/models/X.ts` and `src/<anything>/X.ts` resolve `../foo`
 * to the same place, so the historical file's relative imports keep working
 * untouched. Rewriting them would be a second parser to get wrong.
 *
 * ## What a failure here means
 *
 * A file whose imports no longer exist cannot be loaded, and that is FINE for
 * the retired ones (`Room`, `Space`, `Analytics`…) — nothing plans them. The
 * caller decides: it knows which collections it still needs, and it fails
 * naming them. A load error is never swallowed into a green run.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** One model file as it stood in the commit before the one that deleted it. */
export interface DeletedModelSource {
  /** Repo-relative path, e.g. `packages/backend/src/models/UserSettings.ts`. */
  readonly repoPath: string;
  /** The commit that deleted it — immutable, unlike a branch name. */
  readonly deletedIn: string;
  readonly source: string;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * A shallow clone has no deletions to find, so it would report "no deleted
 * models" — indistinguishable from a port that has deleted none. Refuse rather
 * than answer a question the repository cannot answer.
 */
export function assertHistoryIsAvailable(repoRoot: string): void {
  if (git(repoRoot, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error(
      'closed-value-set resolution needs git history and this is a SHALLOW clone. ' +
        'A shallow checkout finds no deleted models, which reads exactly like a port ' +
        'that has deleted none — so it must fail rather than pass vacuously. ' +
        'Set `fetch-depth: 0` on the checkout step for the job running this test.'
    );
  }
}

/** The newest deletion of every model file, oldest-first order irrelevant. */
export function deletedModelSources(repoRoot: string, dirInRepo: string): DeletedModelSource[] {
  const log = git(repoRoot, [
    'log',
    '--diff-filter=D',
    '--format=commit %H',
    '--name-only',
    '--',
    dirInRepo,
  ]);

  const newestDeletion = new Map<string, string>();
  let commit = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) {
      commit = line.slice('commit '.length).trim();
      continue;
    }
    const repoPath = line.trim();
    // `git log` walks newest-first, so the FIRST deletion seen for a path is the
    // one that removed it from this branch. A file deleted, restored and deleted
    // again must resolve to the last state it actually had.
    if (repoPath.startsWith(dirInRepo) && !newestDeletion.has(repoPath)) {
      newestDeletion.set(repoPath, commit);
    }
  }

  return [...newestDeletion].map(([repoPath, deletedIn]) => ({
    repoPath,
    deletedIn,
    source: git(repoRoot, ['show', `${deletedIn}^:${repoPath}`]),
  }));
}

/**
 * Materialise the sources beside the live models and import them.
 *
 * Import order matters: the caller must have loaded the LIVE models first, so a
 * historical file whose model name is still registered throws
 * `OverwriteModelError` and leaves the live definition in place — the live one
 * is the truth wherever both exist.
 *
 * @returns the files that could not be loaded, with the reason. Retired models
 * routinely land here; the caller decides whether any of them mattered.
 */
export async function loadDeletedModels(
  sources: readonly DeletedModelSource[],
  scratchDir: string
): Promise<{ repoPath: string; reason: string }[]> {
  const unloadable: { repoPath: string; reason: string }[] = [];
  mkdirSync(scratchDir, { recursive: true });
  try {
    for (const entry of sources) {
      const file = path.join(scratchDir, path.basename(entry.repoPath));
      writeFileSync(file, entry.source, 'utf8');
      try {
        await import(/* @vite-ignore */ pathToFileURL(file).href);
      } catch (error) {
        unloadable.push({ repoPath: entry.repoPath, reason: (error as Error).message });
      }
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
  return unloadable;
}
