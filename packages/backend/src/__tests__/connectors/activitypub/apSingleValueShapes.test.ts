import { describe, expect, it } from 'bun:test';
import { buildFederatedNoteProvenance } from '../../../connectors/activitypub/apPostContent';
import { extractActorUri } from '../../../connectors/activitypub/helpers';
import { addressesLocalUsers } from '../../../connectors/activitypub/inbox.service';

/**
 * JSON-LD lets a server send a one-element list as the value itself and a
 * reference as a `Link`. One case per reader class: each used to read only the
 * shape Mastodon sends and dropped the rest without a trace.
 */

describe('ActivityPub readers accept every JSON-LD shape', () => {
  it('keeps a reply whose only Mention tag (not a list) names a local user', () => {
    expect(
      addressesLocalUsers({
        type: 'Note',
        tag: { type: 'Mention', href: 'https://mention.earth/ap/users/alice', name: '@alice' },
      }),
    ).toBe(true);
  });

  it('reads the author of an attributedTo list, not its channel', () => {
    expect(
      extractActorUri([
        { type: 'Group', id: 'https://tube.example/video-channels/c' },
        { type: 'Person', id: 'https://tube.example/accounts/a' },
      ]),
    ).toBe('https://tube.example/accounts/a');
  });

  it('stores the text/html page of a Link-list url, not the AP id', () => {
    const federation = buildFederatedNoteProvenance({
      activityId: 'https://tube.example/videos/watch/1',
      actorUri: 'https://tube.example/accounts/a',
      noteUrl: [
        { type: 'Link', mediaType: 'application/x-mpegURL', href: 'https://tube.example/1.m3u8' },
        { type: 'Link', mediaType: 'text/html', href: 'https://tube.example/w/1' },
      ],
    });
    expect(federation.url).toBe('https://tube.example/w/1');
  });
});
