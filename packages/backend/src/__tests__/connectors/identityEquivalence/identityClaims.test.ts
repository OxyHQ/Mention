import { describe, expect, it } from 'vitest';
import { readCrossNetworkIdentityClaims } from '../../../connectors/identityEquivalence/identityClaims';

/**
 * WHAT COUNTS AS AN ACCOUNT SAYING IT IS ALSO AN ACCOUNT SOMEWHERE ELSE.
 *
 * The negative cases here are the load-bearing ones. Every field this refuses to
 * read is a field somebody could put anything in — a bio, an unverified link, a
 * matching username — and reading any of them would turn "two people picked the
 * same word" into a merge. The positives are narrow on purpose: `alsoKnownAs`,
 * which exists for exactly this, and a profile link the REMOTE INSTANCE checked.
 */

const THREADS_LINK =
  '<a href="https://www.threads.net/@zuck" rel="me nofollow noopener noreferrer">'
  + '<span>https://</span><span>threads.net/@zuck</span></a>';

describe('readCrossNetworkIdentityClaims — what it reads', () => {
  it('reads an alsoKnownAs pointing at a paired network', () => {
    const claims = readCrossNetworkIdentityClaims({
      federatedUsername: 'zuck@instagram.com',
      actorUri: 'https://kilogram.makeup/users/zuck',
      alsoKnownAs: ['https://www.threads.net/@zuck'],
    });

    expect(claims).toEqual([
      {
        subject: 'zuck@instagram.com',
        subjectActorUri: 'https://kilogram.makeup/users/zuck',
        target: 'zuck@threads.net',
        kind: 'also-known-as',
        source: 'https://www.threads.net/@zuck',
      },
    ]);
  });

  it('reads a profile link the remote instance verified', () => {
    const claims = readCrossNetworkIdentityClaims({
      federatedUsername: 'zuck@instagram.com',
      actorUri: 'https://kilogram.makeup/users/zuck',
      fields: [{ name: 'Threads', value: THREADS_LINK, verifiedAt: new Date('2026-09-01') }],
    });

    expect(claims).toMatchObject([{ target: 'zuck@threads.net', kind: 'verified-profile-link' }]);
  });

  it('counts one statement once, however many times a profile repeats it', () => {
    const claims = readCrossNetworkIdentityClaims({
      federatedUsername: 'zuck@instagram.com',
      actorUri: 'https://kilogram.makeup/users/zuck',
      alsoKnownAs: ['https://www.threads.net/@zuck', 'https://threads.net/@zuck'],
    });

    expect(claims).toHaveLength(1);
  });
});

describe('readCrossNetworkIdentityClaims — what it refuses', () => {
  it('refuses an UNVERIFIED profile link, however emphatically it says rel=me', () => {
    const claims = readCrossNetworkIdentityClaims({
      federatedUsername: 'zuck@instagram.com',
      actorUri: 'https://kilogram.makeup/users/zuck',
      fields: [{ name: 'Threads', value: THREADS_LINK }],
    });

    expect(claims).toEqual([]);
  });

  it('refuses a verified link that never asked to be an identity claim', () => {
    const claims = readCrossNetworkIdentityClaims({
      federatedUsername: 'zuck@instagram.com',
      actorUri: 'https://kilogram.makeup/users/zuck',
      fields: [
        {
          name: 'Threads',
          value: '<a href="https://www.threads.net/@zuck" rel="nofollow">threads</a>',
          verifiedAt: new Date('2026-09-01'),
        },
      ],
    });

    expect(claims).toEqual([]);
  });

  /**
   * The `Official` field a `kilogram.makeup` actor publishes is `zuck@instagram.com`
   * pointing at `https://www.instagram.com/zuck` — ITSELF. It is the input the
   * bridge relabeller already read to derive that identity, and reading it again
   * here would have an account vouch for itself.
   */
  it('refuses a claim naming the subject itself', () => {
    const claims = readCrossNetworkIdentityClaims({
      federatedUsername: 'zuck@instagram.com',
      actorUri: 'https://kilogram.makeup/users/zuck',
      alsoKnownAs: ['https://www.instagram.com/zuck'],
      fields: [
        {
          name: 'Official',
          value:
            '<a href="https://www.instagram.com/zuck" rel="me nofollow">instagram.com/zuck</a>',
          verifiedAt: new Date('2026-09-01'),
        },
      ],
    });

    expect(claims).toEqual([]);
  });

  it('refuses a claim aimed at a network no reviewed pair mentions', () => {
    const claims = readCrossNetworkIdentityClaims({
      federatedUsername: 'zuck@instagram.com',
      actorUri: 'https://kilogram.makeup/users/zuck',
      alsoKnownAs: ['https://x.com/finkd', 'https://bsky.app/profile/zuck.bsky.social'],
    });

    expect(claims).toEqual([]);
  });

  it('refuses a Mastodon migration pointer, which names no network at all', () => {
    const claims = readCrossNetworkIdentityClaims({
      federatedUsername: 'zuck@instagram.com',
      actorUri: 'https://kilogram.makeup/users/zuck',
      alsoKnownAs: ['https://mastodon.social/users/zuck'],
    });

    expect(claims).toEqual([]);
  });

  it('reads nothing at all off an actor that publishes nothing', () => {
    expect(
      readCrossNetworkIdentityClaims({
        federatedUsername: 'zuck@threads.net',
        actorUri: 'https://threads.net/ap/users/17841401746480004/',
      }),
    ).toEqual([]);
  });
});
