import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaItem } from '@mention/shared-types';
import type { ExtractedMediaAttachment } from '../../../connectors/shared/federatedMedia';

/**
 * Unit tests for the shared federated-note content builder — the single
 * extraction + empty-note guard both federated ingest paths (inbox `Create` and
 * outbox backfill) now share. `materializeFederatedMedia` is mocked so no
 * network/S3 I/O runs; its "permanent drop" behavior (returning empty media) is
 * simulated to exercise the media-only-post guard.
 */

const h = vi.hoisted(() => ({
  materializeFederatedMedia: vi.fn<
    (
      media: MediaItem[],
      attachments: ExtractedMediaAttachment[],
      ownerOxyUserId: string | null | undefined,
      context?: { activityId?: string; actorUri?: string },
    ) => Promise<{ media: MediaItem[]; attachments: ExtractedMediaAttachment[] }>
  >(),
}));

vi.mock('../../../connectors/shared/federatedMedia', () => ({
  materializeFederatedMedia: h.materializeFederatedMedia,
}));

import {
  buildFederatedNoteContent,
  buildFederatedNoteContentForEdit,
  extractApContentHtml,
} from '../../../connectors/activitypub/apPostContent';

beforeEach(() => {
  h.materializeFederatedMedia.mockReset();
  // Default: pass media through unchanged (nothing dropped).
  h.materializeFederatedMedia.mockImplementation(async (media, attachments) => ({ media, attachments }));
});

describe('extractApContentHtml', () => {
  it('prefers a non-empty top-level content', () => {
    expect(extractApContentHtml({ content: '<p>hi</p>', contentMap: { es: '<p>hola</p>' } })).toBe('<p>hi</p>');
  });

  it('falls back to the declared primary-language contentMap variant', () => {
    expect(
      extractApContentHtml({ content: '', language: 'es', contentMap: { en: '<p>hi</p>', es: '<p>hola</p>' } }),
    ).toBe('<p>hola</p>');
  });

  it('falls back to the first non-empty contentMap variant when no language resolves', () => {
    expect(extractApContentHtml({ content: '', contentMap: { en: '<p>hi</p>', es: '<p>hola</p>' } })).toBe('<p>hi</p>');
  });

  it('returns empty string when neither content nor contentMap is usable', () => {
    expect(extractApContentHtml({ content: '' })).toBe('');
    expect(extractApContentHtml({})).toBe('');
    expect(extractApContentHtml(null)).toBe('');
  });
});

describe('buildFederatedNoteContent', () => {
  it('keeps a content-warning-only post and surfaces the summary as spoilerText', async () => {
    const built = await buildFederatedNoteContent(
      { content: '', summary: 'CW: spoilers ahead', sensitive: true },
      'owner-1',
      {},
    );
    expect(built.skip).toBeFalsy();
    if (built.skip) throw new Error('expected content');
    expect(built.text).toBe('');
    expect(built.summary).toBe('CW: spoilers ahead');
    expect(built.sensitive).toBe(true);
  });

  it('recovers text from a contentMap-only note (empty top-level content)', async () => {
    const built = await buildFederatedNoteContent({ content: '', contentMap: { es: '<p>hola mundo</p>' } }, 'owner-1', {});
    expect(built.skip).toBeFalsy();
    if (built.skip) throw new Error('expected content');
    expect(built.text).toBe('hola mundo');
  });

  it('skips a media-only note whose only attachment was dropped as permanently unavailable', async () => {
    // Simulate materialization permanently dropping the sole remote image.
    h.materializeFederatedMedia.mockResolvedValue({ media: [], attachments: [] });

    const built = await buildFederatedNoteContent(
      {
        content: '',
        attachment: [{ type: 'Document', mediaType: 'image/png', url: 'https://remote.example/a.png' }],
      },
      'owner-1',
      {},
    );
    expect(built.skip).toBe(true);
    if (!built.skip) throw new Error('expected skip');
    expect(built.reason).toBe('empty-federated-note');
  });

  it('keeps an all-hashtag note: tags captured and the body is not blanked', async () => {
    const built = await buildFederatedNoteContent({ content: '<p>#art #photo #nature #travel</p>' }, 'owner-1', {});
    expect(built.skip).toBeFalsy();
    if (built.skip) throw new Error('expected content');
    expect(built.hashtags).toEqual(expect.arrayContaining(['art', 'photo', 'nature', 'travel']));
    // The spammy block would normalize to empty text; the builder restores the
    // raw hashtag text rather than blanking the post.
    expect(built.text.trim().length).toBeGreaterThan(0);
  });

  it('skips a genuinely empty note (no text, no media, no attachments, no summary)', async () => {
    const built = await buildFederatedNoteContent({ content: '' }, 'owner-1', {});
    expect(built.skip).toBe(true);
    if (!built.skip) throw new Error('expected skip');
    expect(built.reason).toBe('empty-federated-note');
  });

  it('produces identical stored text for the same object (inbox/outbox symmetry)', async () => {
    // Both the inbox Create path and the outbox backfill now call this one
    // builder, so a hashtag-bearing note stores the SAME normalized body on both
    // paths. Before the fix, only the outbox path ran hashtag normalization.
    const object = { content: '<p>Hello world #a #b #c #d</p>' };
    const first = await buildFederatedNoteContent(object, 'owner-1', {});
    const second = await buildFederatedNoteContent(object, 'owner-1', {});
    if (first.skip || second.skip) throw new Error('expected content');
    expect(first.text).toBe('Hello world #a');
    expect(second.text).toBe(first.text);
    expect(second.hashtags).toEqual(first.hashtags);
  });
});

describe('buildFederatedNoteContentForEdit', () => {
  it('recovers text from an edited contentMap-only note', async () => {
    const built = await buildFederatedNoteContentForEdit(
      { content: '', contentMap: { es: '<p>texto editado</p>' } },
      'owner-1',
      {},
    );
    expect(built.text).toBe('texto editado');
  });

  it('surfaces the content-warning summary and sensitive flag on an edited CW note', async () => {
    const built = await buildFederatedNoteContentForEdit(
      { content: '<p>body</p>', summary: 'CW: edited warning', sensitive: true },
      'owner-1',
      {},
    );
    expect(built.text).toBe('body');
    expect(built.summary).toBe('CW: edited warning');
    expect(built.sensitive).toBe(true);
  });

  it('does NOT skip a genuinely empty edit — an edit applies (never drops) its fields', async () => {
    // Create semantics would SKIP this; edit semantics must return applicable
    // (empty) fields so a legitimate clear is written to the existing post.
    const built = await buildFederatedNoteContentForEdit({ content: '' }, 'owner-1', {});
    expect(built.text).toBe('');
    expect(built.media).toEqual([]);
    expect(built.attachments).toEqual([]);
    expect(built.summary).toBeUndefined();
  });

  it('matches the create builder’s extraction for a non-empty note (shared assembly)', async () => {
    // The edit and create paths share one assembler, so a note that passes the
    // create guard extracts identically on both.
    const object = { content: '<p>Hello world #a #b #c #d</p>' };
    const created = await buildFederatedNoteContent(object, 'owner-1', {});
    const edited = await buildFederatedNoteContentForEdit(object, 'owner-1', {});
    if (created.skip) throw new Error('expected content');
    expect(edited.text).toBe(created.text);
    expect(edited.hashtags).toEqual(created.hashtags);
  });
});
