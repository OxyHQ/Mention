import type { RemoteProfileStats } from '@mention/shared-types/profile';

/** The join date and follow-graph totals a profile page may state. */
export interface ProfileAccountFacts {
  createdAt?: string;
  followersCount?: number;
  followingCount?: number;
}

interface LocalAccountFacts {
  createdAt?: string;
  _count?: { followers?: number; following?: number };
  followersCount?: unknown;
  followingCount?: unknown;
}

/**
 * Which join date and totals a profile states, by where the account lives.
 *
 * A LOCAL account's Oxy record is the account: its `createdAt` is when it
 * joined, and its follow graph is the whole graph.
 *
 * A FEDERATED account's Oxy record is a mirror minted the day Mention first
 * resolved the actor, so both answers belong to its origin instead — `remote`
 * is the origin's own totals and `published` date off the profile-design DTO.
 * Whatever the origin did not tell us stays `undefined` and its row is hidden:
 * a "0 Followers" or "Joined <discovery month>" is a false statement about an
 * account that has existed for years. While `remote` is still loading the
 * answer is the same, so nothing wrong flashes before it lands.
 */
export function profileAccountFacts(
  profile: LocalAccountFacts,
  isFederated: boolean,
  remote: RemoteProfileStats | undefined,
): ProfileAccountFacts {
  if (isFederated) {
    return {
      createdAt: remote?.joinedAt,
      followersCount: remote?.followersCount,
      followingCount: remote?.followingCount,
    };
  }
  return {
    createdAt: profile.createdAt,
    followersCount:
      profile._count?.followers ??
      (typeof profile.followersCount === 'number' ? profile.followersCount : 0),
    followingCount:
      profile._count?.following ??
      (typeof profile.followingCount === 'number' ? profile.followingCount : 0),
  };
}
