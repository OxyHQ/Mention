import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  buildActorUpdate,
  buildPostUpdate,
} from '../../scripts/normalizeFederatedText';

/**
 * The one-shot backfill that cleans the remote text ALREADY stored in Mongo.
 *
 * Only the pure update-builders are exercised — they hold every rule that
 * matters: which helper each field gets, that an emptied optional label is
 * UNSET rather than blanked, that a required field is never emptied, and that a
 * document with nothing to fix produces no write at all (the idempotency the
 * batch loop relies on to avoid rewriting hundreds of thousands of clean posts).
 */

/** The `_id` of the row under test — the builders only echo it into the filter. */
const OID = new mongoose.Types.ObjectId('000000000000000000000001');

describe('buildPostUpdate', () => {
  it('normalizes the body as multiline, keeping the author’s paragraph break', () => {
    const { update, counts } = buildPostUpdate({
      _id: OID,
      content: { text: '  uno   \n   \n   \n  dos  ' },
    });

    expect(update.set['content.text']).toBe('uno\n\ndos');
    expect(update.unset).toEqual({});
    expect(counts.text).toBe(1);
  });

  it('normalizes the content warning as inline text', () => {
    const { update, counts } = buildPostUpdate({
      _id: OID,
      federation: { spoilerText: '  CW:\n  spoilers  ' },
    });

    expect(update.set['federation.spoilerText']).toBe('CW: spoilers');
    expect(counts.spoilerText).toBe(1);
  });

  it('UNSETS a content warning and an alt that normalize to nothing', () => {
    // These are optional labels read as "present ⇒ show it", so a value that
    // normalizes away must disappear, not become an empty string.
    const { update } = buildPostUpdate({
      _id: OID,
      federation: { spoilerText: '   \n  ' },
      content: { media: [{ id: 'a', type: 'image', alt: '  \n ' }] },
    });

    expect(update.unset).toEqual({
      'federation.spoilerText': '',
      'content.media.0.alt': '',
    });
    expect(update.set['federation.spoilerText']).toBeUndefined();
  });

  it('addresses media alt by index so the item’s other fields are never rewritten', () => {
    const { update, counts } = buildPostUpdate({
      _id: OID,
      content: {
        media: [
          { id: 'a', type: 'image', alt: 'ya limpio' },
          { id: 'b', type: 'image', width: 100, alt: '  un gato\n  en una caja ' },
        ],
      },
    });

    // Only the dirty item's `alt` path is written — `content.media` as a whole
    // is never re-serialized, so `id`/`type`/`width` cannot be lost.
    expect(update.set).toEqual({ 'content.media.1.alt': 'un gato en una caja' });
    expect(counts.mediaAlt).toBe(1);
  });

  it('produces NO write for an already-clean post (idempotent)', () => {
    const clean = {
      _id: OID,
      content: { text: 'uno\n\ndos', media: [{ id: 'a', type: 'image', alt: 'un gato' }] },
      federation: { spoilerText: 'CW: spoilers' },
    };
    const { update } = buildPostUpdate(clean);
    expect(update.set).toEqual({});
    expect(update.unset).toEqual({});
  });

  it('leaves a non-string stored value alone', () => {
    // The script normalizes whitespace; it does not repair a corrupt schema.
    const { update } = buildPostUpdate({
      _id: OID,
      content: { text: 42, media: 'not-an-array' },
      federation: { spoilerText: { nested: true } },
    });
    expect(update.set).toEqual({});
    expect(update.unset).toEqual({});
  });
});

describe('buildActorUpdate', () => {
  it('normalizes the username inline and the bio as a body', () => {
    const { update, counts } = buildActorUpdate({
      _id: OID,
      username: '  alice\n ',
      summary: '  línea uno   \n  \n  \n  línea dos ',
    });

    expect(update.set.username).toBe('alice');
    expect(update.set.summary).toBe('línea uno\n\nlínea dos');
    expect(counts.username).toBe(1);
    expect(counts.summary).toBe(1);
  });

  it('never empties the username — it is required and half of a unique index', () => {
    const { update, counts } = buildActorUpdate({ _id: OID, username: '   \n ' });
    expect(update.set.username).toBeUndefined();
    expect(counts.username).toBe(0);
  });

  it('normalizes profile fields by index, preserving the untouched entries', () => {
    const { update, counts } = buildActorUpdate({
      _id: OID,
      fields: [
        { name: 'Web', value: 'carol.example' },
        { name: '  Sitio\n  web ', value: '  carol.example\n ' },
      ],
    });

    expect(update.set).toEqual({
      'fields.1.name': 'Sitio web',
      'fields.1.value': 'carol.example',
    });
    expect(counts.fields).toBe(2);
  });

  it('produces NO write for an already-clean actor (idempotent)', () => {
    const { update } = buildActorUpdate({
      _id: OID,
      username: 'alice',
      summary: 'línea uno\n\nlínea dos',
      fields: [{ name: 'Web', value: 'carol.example' }],
    });
    expect(update.set).toEqual({});
    expect(update.unset).toEqual({});
  });
});
