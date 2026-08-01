/**
 * Labelers, labels and subscriptions, against real rows.
 *
 * Two things are being asserted, and only one of them is the port.
 *
 * **The guard.** `getUserEffectiveLabels` used to run the viewer's subscription
 * list through `ObjectId.isValid` before looking the labelers up, so a labeler
 * created after the cutover — a uuid v7 — silently disappeared from the
 * viewer's effective label set and their hide/warn/blur choice stopped applying
 * to it, with nothing logged and no error anywhere. The first block below fails
 * the moment that filter comes back.
 *
 * **The wire format.** A port may not change a response body, and the two shapes
 * most likely to drift are the ones storage forced apart: `labelDefinitions`
 * moved to its own table, and an absent optional is `null` in Postgres where it
 * was `undefined` (hence absent from the JSON) in Mongoose.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { contentLabels, labelers } from '../../db/schema/moderation';
import { userSettings } from '../../db/schema/userProfile';
import { LabelService } from '../../services/LabelService';

let db: Database;
const createdLabelerIds: string[] = [];
const createdUserIds: string[] = [];

/** A viewer id unique to one test, so subscription state cannot leak between them. */
function viewerId(): string {
  const id = `oxy-label-viewer-${randomUUID()}`;
  createdUserIds.push(id);
  return id;
}

async function makeLabeler(overrides: { name?: string; description?: string } = {}) {
  const labeler = await LabelService.createLabeler({
    name: overrides.name ?? `Labeler ${randomUUID()}`,
    ...(overrides.description === undefined ? {} : { description: overrides.description }),
    creatorId: 'oxy-label-creator',
    labelDefinitions: [
      { slug: 'spam', name: 'Spam', severity: 'low', defaultAction: 'warn' },
      {
        slug: 'gore',
        name: 'Gore',
        description: 'Graphic violence',
        severity: 'high',
        defaultAction: 'hide',
      },
    ],
  });
  createdLabelerIds.push(labeler.id);
  return labeler;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  while (createdLabelerIds.length > 0) {
    const id = createdLabelerIds.pop();
    // Definitions and content labels cascade from the labeler.
    if (id) await db.delete(labelers).where(eq(labelers.id, id));
  }
  while (createdUserIds.length > 0) {
    const id = createdUserIds.pop();
    if (id) await db.delete(userSettings).where(eq(userSettings.oxyUserId, id));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe("a viewer's effective labels — the subscription is never dropped by id shape", () => {
  it('resolves a subscribed labeler whose id is a uuid v7', async () => {
    /**
     * THE regression test. Under the deleted `ObjectId.isValid` filter this
     * labeler is dropped from `labelers` and the viewer's `hide` preference for
     * it stops being applied to anything — the failure is invisible because the
     * call still succeeds and still returns a well-formed object.
     */
    const labeler = await makeLabeler();
    expect(labeler.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i);

    const viewer = viewerId();
    await LabelService.subscribeToLabeler(viewer, labeler.id);
    await LabelService.setLabelActions(viewer, [
      { labelerId: labeler.id, labelSlug: 'gore', action: 'hide' },
    ]);

    const effective = await LabelService.getUserEffectiveLabels(viewer);

    expect(effective.labelers.map((entry) => entry.id)).toEqual([labeler.id]);
    expect(effective.labelActions).toEqual([
      { labelerId: labeler.id, labelSlug: 'gore', action: 'hide' },
    ]);
    // The definitions come back with it, or the viewer's action has no rule to
    // attach to on the client.
    expect(effective.labelers[0].labelDefinitions.map((d) => d.slug)).toEqual(['spam', 'gore']);
  });

  it('returns nothing for a viewer who has no settings row at all', async () => {
    // The vacuity floor: the case above must not pass because everything passes.
    const effective = await LabelService.getUserEffectiveLabels(viewerId());
    expect(effective).toEqual({ labelers: [], labelActions: [] });
  });

  it('tolerates a subscribed labeler that no longer exists', async () => {
    const viewer = viewerId();
    const labeler = await makeLabeler();
    await LabelService.subscribeToLabeler(viewer, labeler.id);
    await db.delete(labelers).where(eq(labelers.id, labeler.id));
    createdLabelerIds.pop();

    // The id stays in the array (there is no foreign key by design); it simply
    // resolves to no labeler rather than throwing.
    const effective = await LabelService.getUserEffectiveLabels(viewer);
    expect(effective.labelers).toEqual([]);
  });
});

describe('subscriptions', () => {
  it('is idempotent, and moves subscriberCount exactly once', async () => {
    const labeler = await makeLabeler();
    const viewer = viewerId();

    await LabelService.subscribeToLabeler(viewer, labeler.id);
    await LabelService.subscribeToLabeler(viewer, labeler.id);

    expect(await LabelService.getSubscribedLabelerIds(viewer)).toEqual([labeler.id]);
    expect((await LabelService.getLabelerById(labeler.id))?.subscriberCount).toBe(1);
  });

  it('unsubscribing removes the id and decrements once', async () => {
    const labeler = await makeLabeler();
    const viewer = viewerId();

    await LabelService.subscribeToLabeler(viewer, labeler.id);
    await LabelService.unsubscribeFromLabeler(viewer, labeler.id);
    await LabelService.unsubscribeFromLabeler(viewer, labeler.id);

    expect(await LabelService.getSubscribedLabelerIds(viewer)).toEqual([]);
    expect((await LabelService.getLabelerById(labeler.id))?.subscriberCount).toBe(0);
  });

  it('never drives subscriberCount below zero', async () => {
    /**
     * `labelers_subscriber_count_check` refuses a negative count, so a counter
     * that had already drifted below its real subscriber set would turn an
     * unsubscribe into a 500 rather than an unsubscribe. The clamp keeps the
     * removal working; the CHECK keeps the column honest.
     */
    const labeler = await makeLabeler();
    const viewer = viewerId();
    await LabelService.subscribeToLabeler(viewer, labeler.id);
    // Drift, exactly as a legacy row could carry it.
    await db.update(labelers).set({ subscriberCount: 0 }).where(eq(labelers.id, labeler.id));

    await expect(
      LabelService.unsubscribeFromLabeler(viewer, labeler.id),
    ).resolves.toBeUndefined();

    expect(await LabelService.getSubscribedLabelerIds(viewer)).toEqual([]);
    expect((await LabelService.getLabelerById(labeler.id))?.subscriberCount).toBe(0);
  });

  it('refuses to subscribe to a labeler that does not exist', async () => {
    await expect(LabelService.subscribeToLabeler(viewerId(), uuidv7())).rejects.toThrow(
      'Labeler not found',
    );
  });

  it('leaves no settings row behind when the subscribe is refused', async () => {
    // The labeler check runs inside the transaction, so the upsert it would have
    // performed rolls back with it.
    const viewer = viewerId();
    await expect(LabelService.subscribeToLabeler(viewer, uuidv7())).rejects.toThrow();

    const rows = await db
      .select({ id: userSettings.id })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, viewer));
    expect(rows).toEqual([]);
  });
});

describe('label action overrides', () => {
  it('replaces only the labelers the request names', async () => {
    const first = await makeLabeler();
    const second = await makeLabeler();
    const viewer = viewerId();

    await LabelService.setLabelActions(viewer, [
      { labelerId: first.id, labelSlug: 'spam', action: 'warn' },
      { labelerId: second.id, labelSlug: 'gore', action: 'hide' },
    ]);
    // A second save that mentions only the first labeler.
    await LabelService.setLabelActions(viewer, [
      { labelerId: first.id, labelSlug: 'spam', action: 'blur' },
    ]);

    await LabelService.subscribeToLabeler(viewer, first.id);
    const { labelActions } = await LabelService.getUserEffectiveLabels(viewer);

    expect(
      [...labelActions].sort((a, b) => a.labelerId.localeCompare(b.labelerId)),
    ).toEqual(
      [
        { labelerId: first.id, labelSlug: 'spam', action: 'blur' },
        { labelerId: second.id, labelSlug: 'gore', action: 'hide' },
      ].sort((a, b) => a.labelerId.localeCompare(b.labelerId)),
    );
  });

  it('takes the last entry when one request repeats a slug', async () => {
    const labeler = await makeLabeler();
    const viewer = viewerId();

    await LabelService.setLabelActions(viewer, [
      { labelerId: labeler.id, labelSlug: 'spam', action: 'warn' },
      { labelerId: labeler.id, labelSlug: 'spam', action: 'hide' },
    ]);

    await LabelService.subscribeToLabeler(viewer, labeler.id);
    const { labelActions } = await LabelService.getUserEffectiveLabels(viewer);
    expect(labelActions).toEqual([
      { labelerId: labeler.id, labelSlug: 'spam', action: 'hide' },
    ]);
  });
});

describe('wire format parity', () => {
  it('emits _id alongside id, and definitions in declared order', async () => {
    const labeler = await makeLabeler({ description: 'A description' });

    expect(labeler._id).toBe(labeler.id);
    expect(labeler.description).toBe('A description');
    expect(labeler.isOfficial).toBe(false);
    expect(labeler.subscriberCount).toBe(0);
    expect(labeler.labelDefinitions).toEqual([
      { slug: 'spam', name: 'Spam', severity: 'low', defaultAction: 'warn' },
      {
        slug: 'gore',
        name: 'Gore',
        description: 'Graphic violence',
        severity: 'high',
        defaultAction: 'hide',
      },
    ]);
  });

  it('OMITS an absent optional rather than sending null', async () => {
    /**
     * Mongoose left `description` `undefined`, which `JSON.stringify` drops.
     * Drizzle hands back `null`, which serializes as `"description": null` — a
     * different response body for the same absent value, and the exact shape a
     * client `if (labeler.description)` check would start rendering as empty.
     */
    const labeler = await makeLabeler();
    expect('description' in labeler).toBe(false);
    expect(JSON.parse(JSON.stringify(labeler))).not.toHaveProperty('description');

    expect('description' in labeler.labelDefinitions[0]).toBe(false);
    expect('description' in labeler.labelDefinitions[1]).toBe(true);
  });

  it('finds a labeler by a case-insensitive substring of its name', async () => {
    const labeler = await makeLabeler({ name: 'Trust and Safety Collective' });
    const found = await LabelService.getLabelers({ search: 'safety colle' });
    expect(found.map((entry) => entry.id)).toContain(labeler.id);
  });

  it('treats a LIKE wildcard in the search term as a literal', async () => {
    /**
     * The Mongo version escaped REGEX metacharacters; `%` and `_` are the ones
     * that matter to `ILIKE`, and leaving them live turns a user's search box
     * into a way to match every labeler in the table.
     */
    const labeler = await makeLabeler({ name: `Percent ${randomUUID()}` });
    const wildcard = await LabelService.getLabelers({ search: '%' });
    expect(wildcard.map((entry) => entry.id)).not.toContain(labeler.id);

    const literal = await LabelService.getLabelers({ search: 'Percent' });
    expect(literal.map((entry) => entry.id)).toContain(labeler.id);
  });
});

describe('applying and removing labels', () => {
  it('applies a label and returns it with the labeler name populated', async () => {
    const labeler = await makeLabeler();
    const targetId = uuidv7();

    const label = await LabelService.applyLabel({
      labelerId: labeler.id,
      targetType: 'post',
      targetId,
      labelSlug: 'gore',
      createdBy: 'oxy-label-creator',
      reason: 'graphic',
    });

    expect(label._id).toBe(label.id);
    expect(label.labelerId).toEqual({ _id: labeler.id, id: labeler.id, name: labeler.name });
    expect(label.reason).toBe('graphic');

    const forContent = await LabelService.getLabelsForContent('post', targetId);
    expect(forContent.map((entry) => entry.labelSlug)).toEqual(['gore']);
    expect(forContent[0].labelerId.name).toBe(labeler.name);
  });

  it('refuses a slug the labeler does not define', async () => {
    const labeler = await makeLabeler();
    await expect(
      LabelService.applyLabel({
        labelerId: labeler.id,
        targetType: 'post',
        targetId: uuidv7(),
        labelSlug: 'nonexistent',
        createdBy: 'oxy-label-creator',
      }),
    ).rejects.toThrow("does not exist in this labeler");
  });

  it('labels a post whose id is a uuid v7, and one that is an ObjectId hex', async () => {
    // `targetId` is polymorphic and unconstrained; both live id shapes must
    // round-trip through it untouched.
    const labeler = await makeLabeler();
    for (const targetId of [uuidv7(), randomUUID().replace(/-/g, '').slice(0, 24)]) {
      await LabelService.applyLabel({
        labelerId: labeler.id,
        targetType: 'post',
        targetId,
        labelSlug: 'spam',
        createdBy: 'oxy-label-creator',
      });
      const found = await LabelService.getLabelsForContent('post', targetId);
      expect(found.map((entry) => entry.targetId)).toEqual([targetId]);
    }
  });

  it('lets only the creator remove a label', async () => {
    const labeler = await makeLabeler();
    const label = await LabelService.applyLabel({
      labelerId: labeler.id,
      targetType: 'post',
      targetId: uuidv7(),
      labelSlug: 'spam',
      createdBy: 'oxy-label-creator',
    });

    await expect(LabelService.removeLabel(label.id, 'someone-else')).rejects.toThrow(
      'Not authorised to remove this label',
    );
    // Refused, and still there — a rejection that also deleted the row would
    // pass an assertion on the error alone.
    const stillThere = await db
      .select({ id: contentLabels.id })
      .from(contentLabels)
      .where(eq(contentLabels.id, label.id));
    expect(stillThere).toHaveLength(1);

    await expect(LabelService.removeLabel(label.id, 'oxy-label-creator')).resolves.toBe(true);
    const gone = await db
      .select({ id: contentLabels.id })
      .from(contentLabels)
      .where(eq(contentLabels.id, label.id));
    expect(gone).toEqual([]);
  });

  it('reports a label id that names nothing as not found, whatever its shape', async () => {
    /**
     * `removeLabel` used to throw `Invalid label id` for anything that was not
     * 24-hex, which the route turned into a 500. A `text` id that matches no row
     * is a 404 — the same answer for a deleted label and for a typo.
     */
    for (const id of [uuidv7(), 'not-an-id-at-all']) {
      await expect(LabelService.removeLabel(id, 'oxy-label-creator')).rejects.toThrow(
        'Label not found',
      );
    }
  });
});
