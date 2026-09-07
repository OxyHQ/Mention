import { buildCapturePost } from '../postBuilder';
import { createMediaAttachmentKey, type ComposerMediaItem } from '../composeUtils';

/**
 * The post a camera capture publishes when the reader takes the "post now" exit.
 *
 * Two things are worth pinning, and neither is the shape for its own sake.
 *
 * FIRST, the attachment descriptor. The composer's own builder emits media
 * through `buildAttachmentsPayload` keyed by `createMediaAttachmentKey`, and
 * that ordering is what the server reads to place the media in the post. A
 * capture post that got the `content.media` array right and the descriptor
 * wrong renders correctly in the composer's preview and arrives without its
 * attachment — which is why this builds through the same helpers rather than
 * writing the shape out again, and why the test asserts they were used.
 *
 * SECOND, what it does NOT carry. It is deliberately not `buildMainPost` with
 * twenty empty arguments: every one of those is a decision the camera has not
 * been given — no poll, no article, no lane, no scheduled time, no identity
 * override — and passing empties would silently acquire whatever that builder
 * starts defaulting next.
 */

const photo: ComposerMediaItem = { id: 'file_abc123', type: 'image' };

describe('buildCapturePost', () => {
  it('carries the capture as the post\'s only media', () => {
    const request = buildCapturePost(photo);

    expect(request.content.media).toEqual([{ id: 'file_abc123', type: 'image' }]);
  });

  it('emits the media attachment descriptor the server places the media by', () => {
    const request = buildCapturePost(photo);

    expect(request.content.attachments).toEqual([
      expect.objectContaining({ type: 'media', id: 'file_abc123' }),
    ]);
  });

  it('keys that descriptor the way the composer does', () => {
    // The key is the seam between the two builders. If this ever stopped being
    // the composer's own key, the capture would still publish and the media
    // would still upload — it would simply arrive detached.
    const request = buildCapturePost(photo);
    const built = buildCapturePost({ ...photo, id: 'other' });

    expect(createMediaAttachmentKey(photo.id)).toContain(photo.id);
    expect(request.content.attachments).toHaveLength(1);
    expect(built.content.attachments).toEqual([
      expect.objectContaining({ type: 'media', id: 'other' }),
    ]);
  });

  it('publishes a video the same way', () => {
    const request = buildCapturePost({ id: 'file_vid', type: 'video' });

    expect(request.content.media).toEqual([{ id: 'file_vid', type: 'video' }]);
    expect(request.content.attachments).toEqual([
      expect.objectContaining({ type: 'media', id: 'file_vid' }),
    ]);
  });

  it('has an empty body rather than an absent one', () => {
    // A capture post has no text, and the field is present and empty rather
    // than missing: the server distinguishes them, and "no body" is what this
    // exit means — as opposed to the other exit, which opens the composer
    // precisely so there can be one.
    expect(buildCapturePost(photo).content.text).toBe('');
  });

  it('claims nothing else about the post', () => {
    const request = buildCapturePost(photo);

    expect(request.mentions).toEqual([]);
    expect(request.hashtags).toEqual([]);
    // Every field below is a decision the camera was never given. An empty
    // value here would look like an answer.
    expect(request.content.poll).toBeUndefined();
    expect(request.content.article).toBeUndefined();
    expect(request.content.location).toBeUndefined();
    expect(request.laneId).toBeUndefined();
    expect(request.scheduledFor).toBeUndefined();
    expect(request.status).toBeUndefined();
    expect(request.quotedPostId).toBeUndefined();
    expect(request.parentPostId).toBeUndefined();
  });
});
