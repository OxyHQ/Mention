import { describe, expect, it } from 'vitest';
import {
  CHANNEL_HANDLE_MAX_LENGTH,
  MAX_CHANNEL_TITLE_LENGTH,
  RESERVED_CHANNEL_HANDLES,
  normalizeChannelHandle,
} from '@mention/shared-types';
import { Channel } from '../../models/Channel';
import { ChannelMember } from '../../models/ChannelMember';
import { ChannelFollow } from '../../models/ChannelFollow';

/**
 * The three Channels models and the ONE handle canonicalizer, validated WITHOUT a
 * database (documents are built and validated, which is where every schema rule
 * lives).
 *
 * What matters here is the pair of things a schema gets silently wrong: a derived
 * field a caller could set to something else, and a default that quietly means the
 * opposite of what the product decided.
 */

describe('normalizeChannelHandle — the ONE canonicalizer', () => {
  it('lowercases, trims and drops a leading @', () => {
    expect(normalizeChannelHandle('  @NewsRoom ')).toBe('newsroom');
  });

  it('makes two spellings of one handle collide, which is what the unique index needs', () => {
    expect(normalizeChannelHandle('NewsRoom')).toBe(normalizeChannelHandle('@newsroom'));
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(CHANNEL_HANDLE_MAX_LENGTH + 1)],
    ['a space', 'news room'],
    ['a hyphen', 'news-room'],
    ['a dot', 'news.room'],
    ['a non-ASCII letter', 'notícias'],
    ['empty', ''],
  ])('rejects %s by returning null, never an empty string', (_label, input) => {
    expect(normalizeChannelHandle(input)).toBeNull();
  });

  it('rejects a non-string rather than coercing it', () => {
    expect(normalizeChannelHandle(undefined)).toBeNull();
    expect(normalizeChannelHandle(null)).toBeNull();
  });

  it('rejects every reserved handle, case-insensitively', () => {
    for (const reserved of RESERVED_CHANNEL_HANDLES) {
      expect(normalizeChannelHandle(reserved)).toBeNull();
      expect(normalizeChannelHandle(reserved.toUpperCase())).toBeNull();
    }
  });
});

describe('Channel model', () => {
  it('derives handleLower from handle rather than trusting a caller', async () => {
    // A caller supplying its own `handleLower` is exactly how two spellings end up
    // both satisfying the unique index. The hook always wins.
    const channel = new Channel({
      handle: '@NewsRoom',
      handleLower: 'something-else',
      title: 'The Newsroom',
      ownerOxyUserId: 'owner-1',
    });
    await channel.validate();
    expect(channel.handle).toBe('newsroom');
    expect(channel.handleLower).toBe('newsroom');
  });

  it('refuses an illegal handle rather than storing it in a form no reader can find', async () => {
    // The canonicalizer rejects it, so `handleLower` is never set, so `required`
    // fails. That is the intended chain: the model is the last gate.
    const channel = new Channel({
      handle: 'news room',
      title: 'The Newsroom',
      ownerOxyUserId: 'owner-1',
    });
    await expect(channel.validate()).rejects.toThrow();
  });

  it('defaults signPosts to FALSE — a channel post is anonymous unless the owner says otherwise', () => {
    // The default is the product decision, and getting it backwards would publish
    // every writer's identity by omission.
    const channel = new Channel({ handle: 'newsroom', title: 'T', ownerOxyUserId: 'o' });
    expect(channel.signPosts).toBe(false);
  });

  it('defaults visibility to public and all three counters to zero', () => {
    const channel = new Channel({ handle: 'newsroom', title: 'T', ownerOxyUserId: 'o' });
    expect(channel.visibility).toBe('public');
    expect(channel.followerCount).toBe(0);
    expect(channel.memberCount).toBe(0);
    expect(channel.postCount).toBe(0);
  });

  it('caps the title at the shared constant', () => {
    const channel = new Channel({
      handle: 'newsroom',
      title: 'a'.repeat(MAX_CHANNEL_TITLE_LENGTH + 1),
      ownerOxyUserId: 'o',
    });
    expect(channel.validateSync()?.errors?.title).toBeDefined();
  });

  it('declares the unique handle index and the directory keyset', () => {
    const indexes = Channel.schema.indexes();
    const handleIndex = indexes.find(([key]) => 'handleLower' in key);
    expect(handleIndex?.[1]).toMatchObject({ unique: true });
    expect(indexes.some(([key]) =>
      JSON.stringify(key) === JSON.stringify({ visibility: 1, followerCount: -1, _id: -1 }),
    )).toBe(true);
  });
});

describe('ChannelMember model', () => {
  it('defaults a new row to a PENDING publisher — never an accepted one', () => {
    // An invite that defaulted to `accepted` would hand publishing rights to
    // somebody who never answered.
    const member = new ChannelMember({ channelId: 'c1', oxyUserId: 'u1' });
    expect(member.status).toBe('pending');
    expect(member.role).toBe('publisher');
  });

  it('rejects a role or status outside the shared vocabulary', () => {
    const member = new ChannelMember({
      channelId: 'c1',
      oxyUserId: 'u1',
      role: 'moderator',
      status: 'maybe',
    });
    const errors = member.validateSync()?.errors ?? {};
    expect(errors.role).toBeDefined();
    expect(errors.status).toBeDefined();
  });

  it('declares the unique {channelId, oxyUserId} membership identity', () => {
    const unique = ChannelMember.schema
      .indexes()
      .find(([key]) => JSON.stringify(key) === JSON.stringify({ channelId: 1, oxyUserId: 1 }));
    expect(unique?.[1]).toMatchObject({ unique: true });
  });
});

describe('ChannelFollow model', () => {
  it('defaults notify to TRUE — following a channel IS subscribing to it', () => {
    const follow = new ChannelFollow({ channelId: 'c1', oxyUserId: 'u1' });
    expect(follow.notify).toBe(true);
  });

  it('declares the unique follow identity and the fan-out keyset', () => {
    const indexes = ChannelFollow.schema.indexes();
    const unique = indexes.find(
      ([key]) => JSON.stringify(key) === JSON.stringify({ oxyUserId: 1, channelId: 1 }),
    );
    expect(unique?.[1]).toMatchObject({ unique: true });
    // Ascending `_id`, because the fan-out WALKS forward through the followers.
    expect(indexes.some(([key]) =>
      JSON.stringify(key) === JSON.stringify({ channelId: 1, notify: 1, _id: 1 }),
    )).toBe(true);
  });
});
