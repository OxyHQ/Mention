import { describe, it, expect } from 'vitest';
import {
  resolveApAttachment,
  extractApMediaFromNote,
  type ApAttachment,
} from '../../utils/federation/apMedia';

// --- resolveApAttachment ----------------------------------------------------

describe('resolveApAttachment', () => {
  describe('Mastodon string url shape', () => {
    it('resolves a string url with an image mediaType', () => {
      const att: ApAttachment = {
        type: 'Document',
        mediaType: 'image/jpeg',
        url: 'https://mastodon.example/media/photo.jpg',
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://mastodon.example/media/photo.jpg',
        type: 'image',
      });
    });

    it('resolves a string url with a video mediaType', () => {
      const att: ApAttachment = {
        type: 'Document',
        mediaType: 'video/mp4',
        url: 'https://mastodon.example/media/clip.mp4',
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://mastodon.example/media/clip.mp4',
        type: 'video',
      });
    });

    it('trims whitespace in string urls', () => {
      const att: ApAttachment = {
        mediaType: 'image/png',
        url: '  https://example/p.png  ',
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/p.png',
        type: 'image',
      });
    });
  });

  describe('Pleroma/Misskey single Link object shape', () => {
    it('resolves an object url, taking the MIME from the link object', () => {
      const att: ApAttachment = {
        type: 'Document',
        url: { type: 'Link', href: 'https://pleroma.example/v.mp4', mediaType: 'video/mp4' },
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://pleroma.example/v.mp4',
        type: 'video',
      });
    });

    it('falls back to the attachment-level mediaType when the link has none', () => {
      const att: ApAttachment = {
        mediaType: 'image/webp',
        url: { type: 'Link', href: 'https://example/img' },
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/img',
        type: 'image',
      });
    });
  });

  describe('PeerTube/Lemmy array of Link objects', () => {
    it('prefers progressive video/mp4 over HLS and DASH', () => {
      const att: ApAttachment = {
        type: 'Video',
        url: [
          { type: 'Link', href: 'https://peertube.example/master.m3u8', mediaType: 'application/x-mpegURL' },
          { type: 'Link', href: 'https://peertube.example/manifest.mpd', mediaType: 'application/dash+xml' },
          { type: 'Link', href: 'https://peertube.example/720.mp4', mediaType: 'video/mp4' },
        ],
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://peertube.example/720.mp4',
        type: 'video',
      });
    });

    it('falls back to other video/* when no mp4 exists', () => {
      const att: ApAttachment = {
        url: [
          { type: 'Link', href: 'https://example/stream.m3u8', mediaType: 'application/x-mpegURL' },
          { type: 'Link', href: 'https://example/clip.webm', mediaType: 'video/webm' },
        ],
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/clip.webm',
        type: 'video',
      });
    });

    it('uses an HLS manifest only when no progressive variant exists', () => {
      const att: ApAttachment = {
        url: [
          { type: 'Link', href: 'https://example/master.m3u8', mediaType: 'application/x-mpegURL' },
        ],
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/master.m3u8',
        type: 'video',
      });
    });

    it('handles a mixed array of strings and objects', () => {
      const att: ApAttachment = {
        mediaType: 'video/mp4',
        url: [
          'https://example/low.mp4',
          { type: 'Link', href: 'https://example/master.m3u8', mediaType: 'application/x-mpegURL' },
        ],
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/low.mp4',
        type: 'video',
      });
    });
  });

  describe('extension inference when mediaType is missing', () => {
    it('classifies a .mp4 href with no MIME as video', () => {
      const att: ApAttachment = { url: 'https://example/no-mime.mp4' };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/no-mime.mp4',
        type: 'video',
      });
    });

    it('classifies a .mp4 href with query string as video', () => {
      const att: ApAttachment = { url: 'https://example/no-mime.mp4?token=abc' };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/no-mime.mp4?token=abc',
        type: 'video',
      });
    });

    it('classifies a .jpg href with no MIME as image', () => {
      const att: ApAttachment = { url: 'https://example/photo.jpg' };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/photo.jpg',
        type: 'image',
      });
    });

    it('classifies a .m3u8 href with no MIME as video', () => {
      const att: ApAttachment = { url: 'https://example/master.m3u8' };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/master.m3u8',
        type: 'video',
      });
    });
  });

  describe('malformed / empty entries', () => {
    it('returns null for null/undefined attachment', () => {
      expect(resolveApAttachment(null)).toBeNull();
      expect(resolveApAttachment(undefined)).toBeNull();
    });

    it('returns null when url is missing', () => {
      expect(resolveApAttachment({ type: 'Document', mediaType: 'video/mp4' })).toBeNull();
    });

    it('returns null for an empty string url', () => {
      expect(resolveApAttachment({ url: '   ' })).toBeNull();
    });

    it('returns null for a link object without a usable href', () => {
      expect(resolveApAttachment({ url: { type: 'Link', mediaType: 'video/mp4' } })).toBeNull();
    });

    it('returns null for an unknown type that cannot be classified', () => {
      expect(resolveApAttachment({ url: 'https://example/file.pdf', mediaType: 'application/pdf' })).toBeNull();
    });

    it('skips bad entries in an array and resolves the good one', () => {
      const att: ApAttachment = {
        url: [
          { type: 'Link', mediaType: 'video/mp4' },
          'https://example/good.mp4',
        ],
      };
      expect(resolveApAttachment(att)).toEqual({
        href: 'https://example/good.mp4',
        type: 'video',
      });
    });

    it('returns null for an array of only malformed entries', () => {
      const att: ApAttachment = {
        url: [{ type: 'Link' }, { type: 'Link', mediaType: 'video/mp4' }],
      };
      expect(resolveApAttachment(att)).toBeNull();
    });
  });
});

// --- extractApMediaFromNote -------------------------------------------------

describe('extractApMediaFromNote', () => {
  it('returns empty arrays when there is no attachment array', () => {
    expect(extractApMediaFromNote({})).toEqual({ media: [], attachments: [] });
    expect(extractApMediaFromNote({ attachment: 'not-an-array' })).toEqual({
      media: [],
      attachments: [],
    });
  });

  it('preserves the exact MediaItem + attachment descriptor shape (no extra fields)', () => {
    const note = {
      attachment: [
        { type: 'Document', mediaType: 'image/jpeg', url: 'https://example/a.jpg' },
      ],
    };
    const out = extractApMediaFromNote(note);
    expect(out).toEqual({
      media: [{ id: 'https://example/a.jpg', type: 'image' }],
      attachments: [{ type: 'media', id: 'https://example/a.jpg', mediaType: 'image' }],
    });
    // Guard: id is always a string, never an object/array.
    expect(typeof out.media[0].id).toBe('string');
    expect(Object.keys(out.media[0]).sort()).toEqual(['id', 'type']);
  });

  it('extracts multiple attachments and skips unclassifiable ones', () => {
    const note = {
      attachment: [
        { mediaType: 'image/png', url: 'https://example/1.png' },
        { mediaType: 'application/pdf', url: 'https://example/doc.pdf' },
        {
          type: 'Video',
          url: [
            { href: 'https://example/master.m3u8', mediaType: 'application/x-mpegURL' },
            { href: 'https://example/720.mp4', mediaType: 'video/mp4' },
          ],
        },
      ],
    };
    expect(extractApMediaFromNote(note)).toEqual({
      media: [
        { id: 'https://example/1.png', type: 'image' },
        { id: 'https://example/720.mp4', type: 'video' },
      ],
      attachments: [
        { type: 'media', id: 'https://example/1.png', mediaType: 'image' },
        { type: 'media', id: 'https://example/720.mp4', mediaType: 'video' },
      ],
    });
  });

  it('matches the legacy Mastodon string behavior with no regression', () => {
    const note = {
      attachment: [
        { type: 'Document', mediaType: 'image/jpeg', url: 'https://m.example/x.jpg' },
        { type: 'Document', mediaType: 'video/mp4', url: 'https://m.example/y.mp4' },
      ],
    };
    expect(extractApMediaFromNote(note)).toEqual({
      media: [
        { id: 'https://m.example/x.jpg', type: 'image' },
        { id: 'https://m.example/y.mp4', type: 'video' },
      ],
      attachments: [
        { type: 'media', id: 'https://m.example/x.jpg', mediaType: 'image' },
        { type: 'media', id: 'https://m.example/y.mp4', mediaType: 'video' },
      ],
    });
  });
});
