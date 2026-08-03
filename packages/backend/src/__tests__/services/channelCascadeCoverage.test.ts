import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHANNEL_CASCADE,
  EMBEDDED_CHANNEL_REFERENCES,
  NOT_A_CHANNEL_REFERENCE,
  OWNED_BY_OXY,
} from '../../services/channelDeletion/channelCascadeManifest';

/**
 * Deleting a channel has to remove EVERYTHING that points at it. A cascade
 * written by hand satisfies that on the day it is written and then decays
 * silently: somebody adds a model with a `postId`, nothing references it from
 * the cascade, and rows keep pointing at a channel that no longer exists. There
 * is no error, no failing request and no log line — the first symptom is a
 * hydration miss months later.
 *
 * So the cascade is enumerated as data (`channelCascadeManifest.ts`) and this
 * test compares that data against the REAL model tree. A new model carrying an
 * id-shaped field fails this test on the commit that adds it, and the failure
 * names the field and says which list to put it in.
 *
 * WHY THE SCANNER KEYS ON ID SHAPE AND NOT ON A LIST OF KNOWN NAMES
 *
 * The first version of this matched a hand-written set of names (`postId`,
 * `oxyUserId`, `authorId`, …). Run against the tree it missed
 * `ModerationEnforcement.subjectId` — a real reference to a post, under a name
 * nobody would have thought to list — and `Trending.actorIds`. A name list can
 * only find references somebody already knew about, which is precisely the class
 * of bug this test exists to prevent. Matching the SHAPE (`…Id`, `…Ids`, `…Uri`,
 * and a few explicit extras) over-collects instead, and every over-collection is
 * dismissed once, in writing, in `NOT_A_CHANNEL_REFERENCE`.
 *
 * Modelled on `__tests__/agentsMdReferences.test.ts`, which is this repo's
 * reference implementation of a source-scanning gate with a vacuity floor.
 */

const MODELS_DIR = resolve(__dirname, '../../models');

/**
 * A schema field declaration: two or more leading spaces, an identifier, a
 * colon. Deliberately loose — it also picks up nested option objects and index
 * definitions, and over-collecting is the safe direction here. Anything it
 * catches that is not a reference gets dismissed in `NOT_A_CHANNEL_REFERENCE`,
 * which costs one line and buys the guarantee that nothing is missed.
 */
const FIELD_DECLARATION = /^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;

/**
 * Which of those field names could carry a reference to an account or a post.
 * `Of$` catches `boostOf`/`quoteOf`; the named extras are the reference fields
 * that carry no id-ish suffix at all.
 */
const ID_SHAPED = /Id$|Ids$|Uri$|Uris$|Of$|Authors$|^createdBy$|^reporter$|^mentions$|^edges$/;

function modelFiles(): string[] {
  return readdirSync(MODELS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

/** Every `Model.field` key declared in every model, optionally narrowed to id-shaped ones. */
function declaredKeys(onlyIdShaped: boolean): string[] {
  const keys: string[] = [];
  for (const file of modelFiles()) {
    const model = file.replace(/\.ts$/, '');
    const source = readFileSync(resolve(MODELS_DIR, file), 'utf8');
    const fields = new Set(
      Array.from(source.matchAll(FIELD_DECLARATION), (match) => match[1]).filter(
        (field) => !onlyIdShaped || ID_SHAPED.test(field),
      ),
    );
    for (const field of [...fields].sort()) keys.push(`${model}.${field}`);
  }
  return keys;
}

const cascadeKeys = new Set(CHANNEL_CASCADE.map((step) => `${step.model}.${step.field}`));
const declared = declaredKeys(true);
/**
 * The staleness check below runs against EVERY declared field, not just the
 * id-shaped ones, because the cascade legitimately covers a few references whose
 * names carry no id suffix (`UserSettings.restrictedUsers`). Narrowing both
 * directions to the same regex would report those as stale.
 */
const allDeclared = new Set(declaredKeys(false));
const files = modelFiles();

describe('channel deletion cascade covers the real model tree', () => {
  it('scans a plausible number of models and reference fields', () => {
    // The vacuity floor. A traversal that silently found nothing — a moved
    // directory, a regex that stopped matching — would make every assertion
    // below pass by checking nothing, which is the exact failure this file
    // exists to prevent elsewhere.
    expect(files.length).toBeGreaterThanOrEqual(55);
    expect(declared.length).toBeGreaterThanOrEqual(120);
    expect(cascadeKeys.size).toBeGreaterThanOrEqual(60);
  });

  it('classifies every id-shaped field in every model', () => {
    const unclassified = declared.filter(
      (key) => !cascadeKeys.has(key) && !NOT_A_CHANNEL_REFERENCE.has(key),
    );

    expect(
      unclassified,
      'These model fields are not covered by the channel-deletion cascade:\n  ' +
        `${unclassified.join('\n  ')}\n` +
        'Every id-shaped field must be classified exactly once. Either add a step to CHANNEL_CASCADE ' +
        '(it references a channel account or a channel post, and here is what the cascade does about it), ' +
        'or add it to NOT_A_CHANNEL_REFERENCE with what the id actually names. Leaving it out means a row ' +
        'pointing at a deleted channel survives, silently.',
    ).toEqual([]);
  });

  it('never classifies one field both ways', () => {
    const both = declared.filter(
      (key) => cascadeKeys.has(key) && NOT_A_CHANNEL_REFERENCE.has(key),
    );

    expect(
      both,
      `These fields are in BOTH CHANNEL_CASCADE and NOT_A_CHANNEL_REFERENCE:\n  ${both.join('\n  ')}\n` +
        'A field is either a reference the cascade handles or not a reference at all. Two answers means ' +
        'the cascade acts on something the manifest also claims is irrelevant.',
    ).toEqual([]);
  });

  it('keeps the manifest from naming fields that no longer exist', () => {
    // The other direction, so the manifest can only ever describe the real tree.
    // Without this a renamed field leaves a cascade step that quietly matches
    // nothing, and the coverage assertion above still passes.
    const stale = [...cascadeKeys, ...NOT_A_CHANNEL_REFERENCE.keys()]
      .filter((key) => !allDeclared.has(key))
      .sort();

    expect(
      stale,
      `The manifest names fields that no models declare:\n  ${stale.join('\n  ')}\n` +
        'The field was renamed or removed. Update the manifest — a step that matches nothing is a cascade ' +
        'that has stopped running while still reading as covered.',
    ).toEqual([]);
  });

  it('writes down the references this scanner structurally cannot see', () => {
    // The blind spot, stated rather than hidden. This test reads DECLARED schema
    // fields, so a reference embedded in a string (`author|<oxyUserId>` inside a
    // feed descriptor) or buried in a `Schema.Types.Mixed` blob
    // (`params.authorIds`) is invisible to it — no schema path names either.
    //
    // A gate whose limits are undocumented gets mistaken for a complete one.
    // These are enumerated by hand instead, each saying whether the cascade
    // reaches it and, when it does not, why that is harmless.
    expect(EMBEDDED_CHANNEL_REFERENCES.size).toBeGreaterThanOrEqual(5);
    for (const [reference, disposition] of EMBEDDED_CHANNEL_REFERENCES) {
      expect(
        /REACHED|SCRUBBED|NOT REACHED/.test(disposition),
        `${reference} must say whether the cascade reaches it — "probably fine" is how a real orphan gets shipped`,
      ).toBe(true);
    }
  });

  it('states what Oxy owns rather than leaving it out', () => {
    // A reference Mention cannot delete is still a reference. The rule the user
    // set is "nothing orphaned", and an orphan on the far side of the Oxy
    // boundary is still an orphan — it just needs a different operator to close
    // it. Silence here would read as "there is nothing else", which is false.
    expect(OWNED_BY_OXY.size).toBeGreaterThanOrEqual(4);
    for (const [boundary, reason] of OWNED_BY_OXY) {
      expect(boundary.length, 'every cross-boundary entry needs a name').toBeGreaterThan(0);
      expect(
        reason.length,
        `${boundary} needs a written reason — an unexplained exemption is how a real gap gets normalised`,
      ).toBeGreaterThan(40);
    }
  });

  it('gives every cascade step a written reason', () => {
    const unexplained = CHANNEL_CASCADE.filter((step) => step.why.trim().length < 20).map(
      (step) => `${step.model}.${step.field}`,
    );

    expect(
      unexplained,
      `These cascade steps have no real justification:\n  ${unexplained.join('\n  ')}\n` +
        'Deleting a row and scrubbing a field are different decisions about somebody else\'s data. ' +
        'The reason is what lets the next person tell a deliberate choice from a copy-paste.',
    ).toEqual([]);
  });

  it('deletes rows that exist only for the channel, and scrubs rows that do not', () => {
    // The distinction the whole design rests on: a row that exists BECAUSE of the
    // channel dies with it; a row that belongs to somebody else keeps its
    // content and loses only the pointer. Getting this backwards either strands
    // an orphan or destroys a third party's post, so the two array-shaped
    // actions may never be used on a row the channel owns outright.
    const scrubbed = CHANNEL_CASCADE.filter(
      (step) => step.action === 'pull-from-array' || step.action === 'unset-field',
    );
    expect(scrubbed.length).toBeGreaterThanOrEqual(10);

    const quoteStep = CHANNEL_CASCADE.find(
      (step) => step.model === 'Post' && step.field === 'quoteOf',
    );
    expect(
      quoteStep?.action,
      'A quote of a destroyed post keeps its author\'s words. Deleting it would destroy a third party\'s ' +
        'writing to remove the channel\'s.',
    ).toBe('unset-field');

    const boostStep = CHANNEL_CASCADE.find(
      (step) => step.model === 'Post' && step.field === 'boostOf',
    );
    expect(
      boostStep?.action,
      'A boost has an intentionally empty body and renders entirely from its original, so a surviving one ' +
        'is a placeholder card with nothing behind it.',
    ).toBe('delete-row');
  });

  it('never reattributes a channel post to the person who wrote it', () => {
    // The one rule that is not about referential integrity at all. With
    // `signPosts` off, reattributing a post to `writtenByOxyUserId` would
    // retroactively publish who wrote what — the single promise a channel makes,
    // broken at the moment the channel is no longer there to answer for it.
    const writerStep = CHANNEL_CASCADE.find(
      (step) => step.model === 'Post' && step.field === 'writtenByOxyUserId',
    );

    expect(writerStep, 'writtenByOxyUserId must be classified, not ignored').toBeDefined();
    expect(
      writerStep?.action,
      'The post is destroyed, never handed to its writer.',
    ).toBe('delete-row');
  });
});
