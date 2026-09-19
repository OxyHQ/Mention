import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { like } from 'drizzle-orm';
import { signWebhookDelivery } from '@oxy.so/crowdsource-testing';

/**
 * `community_note.status_changed`, delivered for real.
 *
 * A note becoming shown is the one CrowdSource event Mention answers without
 * recording anything: there is no decision to apply, nothing to enforce and no
 * row to write, because Mention stores no part of a note. The ONLY thing that
 * happens is that the cached "what note is shown under this post" is dropped —
 * so that drop is what this file watches, and it watches it on a genuinely
 * signed delivery, because a handler that runs on an unsigned one would be a
 * cache anyone could flush.
 */

const WEBHOOK_SECRET = 'test-webhook-secret-at-least-16-chars';
const EVENT_PREFIX = 'evt-note-webhook-';

vi.hoisted(() => {
  vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', 'test-webhook-secret-at-least-16-chars');
});

const notes = vi.hoisted(() => ({ invalidateShownNote: vi.fn(async () => {}) }));

vi.mock('../../../services/communityNotes/CommunityNotesService', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/communityNotes/CommunityNotesService')
  >('../../../services/communityNotes/CommunityNotesService');
  return { ...actual, invalidateShownNote: notes.invalidateShownNote };
});

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { moderationEvents } from '../../../db/schema/moderation';
import { createCrowdSourceWebhookRoutes } from '../../../routes/crowdSourceWebhook.routes';

let app: express.Express;
let eventSeq = 0;

function statusChangedEvent(over: Partial<Record<string, unknown>> = {}) {
  eventSeq += 1;
  return {
    id: `${EVENT_PREFIX}${eventSeq}`,
    type: 'community_note.status_changed',
    createdAt: new Date().toISOString(),
    organizationId: 'org-test',
    applicationId: 'app-mention',
    data: {
      noteId: 'note-1',
      externalSubjectId: 'post-42',
      authorPrincipalId: 'writer-1',
      previousStatus: 'needs_ratings',
      status: 'shown',
    },
    ...over,
  };
}

async function deliver(event: unknown, overrides: Record<string, unknown> = {}) {
  const delivery = signWebhookDelivery({ secret: WEBHOOK_SECRET, event, ...overrides });
  return request(app).post('/webhooks/crowdsource').set(delivery.headers).send(delivery.body);
}

beforeAll(async () => {
  await connectPostgres();
  app = express();
  app.use('/webhooks', createCrowdSourceWebhookRoutes());
});

afterAll(async () => {
  await getDb().delete(moderationEvents).where(like(moderationEvents.id, `${EVENT_PREFIX}%`));
  await closePostgres();
});

beforeEach(() => {
  notes.invalidateShownNote.mockClear();
});

describe('a note changing status', () => {
  it('drops the cached note for the post it is about, and records nothing', async () => {
    const event = statusChangedEvent();

    const response = await deliver(event);

    expect(response.status).toBe(200);
    expect(notes.invalidateShownNote).toHaveBeenCalledWith('post-42');
    const rows = await getDb()
      .select()
      .from(moderationEvents)
      .where(like(moderationEvents.id, `${event.id}`));
    // The dedupe store claims the delivery, as it must for a redelivery to be
    // recognised — but nothing about the note is stored: no case, no decision.
    expect(rows[0]?.caseId ?? null).toBeNull();
  });

  it('does the same again on the redelivery §10.9 guarantees, because a delete is idempotent', async () => {
    const event = statusChangedEvent();

    const first = await deliver(event);
    const second = await deliver(event);

    expect(first.body).toMatchObject({ received: true, duplicate: false });
    expect(second.body).toMatchObject({ received: true, duplicate: true });
    // The second delivery is recognised as a repeat and not handled again; the
    // first one already dropped the entry.
    expect(notes.invalidateShownNote).toHaveBeenCalledTimes(1);
  });

  it('does not touch the cache for a delivery that was not signed by CrowdSource', async () => {
    const event = statusChangedEvent();

    const response = await deliver(event, { secret: 'an-attackers-secret-16-chars-long' });

    expect(response.status).toBe(401);
    expect(notes.invalidateShownNote).not.toHaveBeenCalled();
  });
});
