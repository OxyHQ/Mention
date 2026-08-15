import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildFederatedNoteProvenance } from '../../connectors/activitypub/apPostContent';

/**
 * Every federated post stored by an ingest path must carry the actor URI that
 * authored it, not just the activity id.
 *
 * ## Why this is a static check and not a behavioural one
 *
 * `PostRecordFederation` is entirely optional, so `{ activityId, url }` and
 * `{ activityId, actorUri, url }` type-check identically at a `create` call
 * site. `ensureFederatedNote` — the importer behind boosted originals, reply
 * ancestors and quoted notes — shipped with `actorUri` missing for exactly that
 * reason: the value was in scope one line above (it is handed to
 * `buildFederatedNoteContent`) and nothing objected.
 *
 * Nothing about the missing field is loud. The post stores, hydrates and renders
 * correctly. What breaks is everything that later asks WHO wrote it:
 *
 *  - an inbound `Delete` / `Update` is authorized by
 *    `and(federationActivityId, federationActorUri)`, so a remote deletion of
 *    such a post matches no row and is silently refused;
 *  - `resolveFederationTarget` reads `federation.actorUri` to find the author's
 *    inbox, and every caller (`Like`, `Undo(Like)`, a reply's delivery and its
 *    `Mention` tag, `Announce`) returns early without one;
 *  - `isNotNull(posts.federationActorUri)` is the "is this post federated?"
 *    discriminator used by the blocked-domain purge and the `instance` feed
 *    source, both of which therefore treat the post as LOCAL.
 *
 * A behavioural test would pin whichever of those consequences someone happened
 * to reach for. This pins the RULE at the point the field is written, which is
 * the only place all of them are decided.
 *
 * ## What keeps this check honest
 *
 * A source scan that stops finding anything reads as a pass, so the number of
 * provenance blocks it found — and the number of those that name an
 * `activityId`, which is the subset the rule applies to — are both asserted
 * against floors. Both are minimums rather than exact counts: a new legitimate
 * ingest site must not fail the build, a broken traversal must.
 */

const SOURCE_ROOT = path.resolve(__dirname, '../..');

/**
 * The smallest number of `federation:` blocks this scan may find and still be
 * believed. Nine exist today: the three ActivityPub Note ingest sites (inbox
 * `Create`, outbox backfill, `ensureFederatedNote`) which share
 * `buildFederatedNoteProvenance`, the ActivityPub `Announce` importer, the
 * atproto post importer, the mention-repair script's row type and its rebuilt
 * block, plus two blocks that describe no post at all (the federation config and
 * a hydrated user's federation summary) and so carry no `activityId`.
 */
const MINIMUM_BLOCKS = 9;

/**
 * The smallest number of those blocks that name an `activityId` — the subset the
 * rule actually constrains, seven today. A floor here is what stops the rule
 * going vacuous if the scan starts matching only the blocks it has nothing to
 * say about.
 */
const MINIMUM_IDENTIFIED_BLOCKS = 7;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface ProvenanceBlock {
  file: string;
  line: number;
  /** The keys named inside the block, in source order. */
  keys: string[];
}

/**
 * Every `federation:` value in the tree whose body is an object — written
 * directly (`federation: {`) or through a builder (`federation: fn({`) — paired
 * with the keys it names.
 *
 * Brace-matched rather than regex-captured: a truncated capture is how a scan
 * ends up asserting nothing. Both spellings are read the same way on purpose —
 * the rule is about the fields that reach the post, not about which helper put
 * them there, so routing a site through a builder cannot exempt it.
 */
function findProvenanceBlocks(): ProvenanceBlock[] {
  const blocks: ProvenanceBlock[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8');
    const opener = /federation:\s*(?:[A-Za-z_$][\w$]*\()?\{/g;
    for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
      const bodyStart = match.index + match[0].length;
      let depth = 1;
      let cursor = bodyStart;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '{') depth++;
        else if (source[cursor] === '}') depth--;
        cursor++;
      }
      // An unbalanced block means the scan lost the plot; record it with no keys
      // so the `activityId` implication below cannot silently pass over it.
      const body = depth === 0 ? source.slice(bodyStart, cursor - 1) : '';
      blocks.push({
        file: path.relative(SOURCE_ROOT, file),
        line: source.slice(0, match.index).split('\n').length,
        keys: topLevelKeys(body),
      });
    }
  }
  return blocks;
}

/**
 * The keys of an object body, ignoring anything nested inside a deeper brace,
 * bracket or paren — a `getRemoteHost(x)` argument or a nested literal must not
 * be read as a key of the block being inspected. Comment lines are dropped: a
 * block whose docblock says the word `actorUri` is not a block that stamps it.
 */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const isComment = line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
    if (depth === 0 && !isComment) {
      const key = /^([A-Za-z_$][\w$]*)\s*[:,;?]/.exec(line);
      if (key) keys.push(key[1]);
    }
    for (const char of rawLine) {
      if (char === '{' || char === '[' || char === '(') depth++;
      else if (char === '}' || char === ']' || char === ')') depth--;
    }
  }
  return keys;
}

describe('inbound federated post provenance', () => {
  it('scans enough federation blocks to be worth believing', () => {
    const blocks = findProvenanceBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(MINIMUM_BLOCKS);
    expect(blocks.filter((block) => block.keys.includes('activityId')).length)
      .toBeGreaterThanOrEqual(MINIMUM_IDENTIFIED_BLOCKS);
  });

  it('names an actorUri wherever it names an activityId', () => {
    const missing = findProvenanceBlocks().filter(
      (block) => block.keys.includes('activityId') && !block.keys.includes('actorUri'),
    );

    // Printed in full on failure — the file and line are the fix, and a bare
    // count would leave whoever hits this hunting for it.
    expect(
      missing.map((block) => `${block.file}:${block.line} -> {${block.keys.join(', ')}}`),
    ).toEqual([]);
  });

  it('reads keys out of every block it scanned', () => {
    // A block the brace matcher failed on yields no keys at all, which would
    // pass the implication above for the wrong reason.
    const unreadable = findProvenanceBlocks().filter((block) => block.keys.length === 0);

    expect(unreadable.map((block) => `${block.file}:${block.line}`)).toEqual([]);
  });

  it('stamps the actor uri the caller supplies, and falls back to the activity id for the url', () => {
    expect(
      buildFederatedNoteProvenance({
        activityId: 'https://remote.example/notes/1',
        actorUri: 'https://remote.example/users/alice',
        noteUrl: { nope: true },
      }),
    ).toEqual({
      activityId: 'https://remote.example/notes/1',
      actorUri: 'https://remote.example/users/alice',
      inReplyTo: undefined,
      url: 'https://remote.example/notes/1',
      sensitive: undefined,
      spoilerText: undefined,
    });
  });
});
