import { buildAttachmentsPayload } from '../attachmentsUtils';
import type { ComposerMediaItem } from '../composeUtils';

const mediaItem = (id: string, type: 'image' | 'video' | 'gif' = 'image'): ComposerMediaItem => ({
  id,
  type,
});

describe('buildAttachmentsPayload', () => {
  it('emits nothing for an empty order with no flags and no media', () => {
    expect(buildAttachmentsPayload([], [], {})).toEqual([]);
  });

  it('emits every non-media attachment flagged, in the order requested', () => {
    const result = buildAttachmentsPayload(
      ['poll', 'article', 'event', 'location', 'sources', 'room'],
      [],
      {
        includePoll: true,
        includeArticle: true,
        includeEvent: true,
        includeLocation: true,
        includeSources: true,
        includeRoom: true,
      },
    );
    expect(result.map((d) => d.type)).toEqual(['poll', 'article', 'event', 'location', 'sources', 'room']);
  });

  it('drops a non-media key from the order when its flag is not set', () => {
    const result = buildAttachmentsPayload(['poll'], [], { includePoll: false });
    expect(result).toEqual([]);
  });

  it('never duplicates a non-media attachment even if its key appears twice', () => {
    const result = buildAttachmentsPayload(['poll', 'poll'], [], { includePoll: true });
    expect(result.filter((d) => d.type === 'poll')).toHaveLength(1);
  });

  it('appends a flagged non-media attachment even when the order never named it', () => {
    const result = buildAttachmentsPayload([], [], { includeArticle: true });
    expect(result).toEqual([{ type: 'article' }]);
  });

  it('emits a podcast descriptor when podcastId is set, from the order or as a fallback', () => {
    expect(buildAttachmentsPayload(['podcast'], [], { podcastId: 'show-1' })).toEqual([
      { type: 'podcast', id: 'show-1' },
    ]);
    // Not named in `order` at all — still appended, mirroring the trailing flags above.
    expect(buildAttachmentsPayload([], [], { podcastId: 'show-1' })).toEqual([
      { type: 'podcast', id: 'show-1' },
    ]);
  });

  it('emits nothing for podcast when podcastId is absent, even if the order names it', () => {
    expect(buildAttachmentsPayload(['podcast'], [], {})).toEqual([]);
  });

  it('emits a job descriptor when jobId is set, from the order or as a fallback (OxyHQ/Mention#952)', () => {
    expect(buildAttachmentsPayload(['job'], [], { jobId: 'job-1' })).toEqual([
      { type: 'job', id: 'job-1' },
    ]);
    expect(buildAttachmentsPayload([], [], { jobId: 'job-1' })).toEqual([
      { type: 'job', id: 'job-1' },
    ]);
  });

  it('emits nothing for job when jobId is absent, even if the order names it', () => {
    expect(buildAttachmentsPayload(['job'], [], {})).toEqual([]);
  });

  it('never duplicates the job descriptor when it appears in the order AND as a trailing default', () => {
    const result = buildAttachmentsPayload(['job'], [], { jobId: 'job-1' });
    expect(result.filter((d) => d.type === 'job')).toHaveLength(1);
  });

  it('orders media by the requested key, then appends any unused media at the end', () => {
    const media = [mediaItem('a'), mediaItem('b', 'video'), mediaItem('c', 'gif')];
    const result = buildAttachmentsPayload(['media:b', 'media:a'], media, {});
    expect(result).toEqual([
      { type: 'media', id: 'b', mediaType: 'video' },
      { type: 'media', id: 'a', mediaType: 'image' },
      { type: 'media', id: 'c', mediaType: 'gif' },
    ]);
  });

  it('ignores a media key naming an id not present in the media list', () => {
    expect(buildAttachmentsPayload(['media:missing'], [], {})).toEqual([]);
  });

  it('mixes every attachment kind together in one coherent, deduplicated payload', () => {
    const media = [mediaItem('m1')];
    const result = buildAttachmentsPayload(
      ['poll', 'media:m1', 'podcast', 'job'],
      media,
      { includePoll: true, podcastId: 'show-1', jobId: 'job-1' },
    );
    expect(result).toEqual([
      { type: 'poll' },
      { type: 'media', id: 'm1', mediaType: 'image' },
      { type: 'podcast', id: 'show-1' },
      { type: 'job', id: 'job-1' },
    ]);
  });
});
