import { buildModuleCatalog } from '../mtn/feed/moduleCatalog';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { registerSignalModules } from '../mtn/feed/engine/signals';
import { describe, expect, it } from 'vitest';
import {
  activitySubscriptionSignal,
  ACTIVITY_SUBSCRIPTION_BOOST,
} from '../services/ranking/signals/activitySubscription';
import { FeedRankingService } from '../services/FeedRankingService';
import { buildSignalContext } from '../services/ranking/signalContext';
import { feedCandidate } from './fixtures/feedCandidate';
import {
  forYouDefinition,
  followingDefinition,
  videosDefinition,
  exploreDefinition,
} from '../mtn/feed/definitions/presets';

const now = Date.UTC(2026, 9, 22, 0);
const context = {
  rankingAsOf: now,
  enabledSignals: new Set(['activitySubscriptionBoost']),
  activitySubscribedAuthorIdsSet: new Set(['bell-author']),
};
const post = (ageHours: number) =>
  feedCandidate({ oxyUserId: 'bell-author', createdAt: new Date(now - ageHours * 3_600_000) });
const score = (ageHours: number) =>
  activitySubscriptionSignal.score(post(ageHours), buildSignalContext('viewer', context));

describe('explicit bell interest in For You', () => {
  it('gives fresh posts a bounded, decaying lift without permanently prioritizing old posts', () => {
    expect(score(0)).toBe(ACTIVITY_SUBSCRIPTION_BOOST.maxMultiplier);
    expect(score(24)).toBe(1.5);
    expect(score(48)).toBe(1.25);
    expect(score(73)).toBe(1);
    expect(score(-1)).toBe(1);
    expect(
      activitySubscriptionSignal.score(
        { ...post(0), createdAt: 'invalid' },
        buildSignalContext('viewer', context),
      ),
    ).toBe(1);
  });
  it('requires authenticated explicit interest and an enabled signal', () => {
    expect(activitySubscriptionSignal.score(post(0), buildSignalContext(undefined, context))).toBe(
      1,
    );
    expect(
      activitySubscriptionSignal.score(
        post(0),
        buildSignalContext('viewer', { ...context, enabledSignals: new Set() }),
      ),
    ).toBe(1);
    expect(
      activitySubscriptionSignal.score(
        post(0),
        buildSignalContext('other', { ...context, activitySubscribedAuthorIdsSet: new Set() }),
      ),
    ).toBe(1);
    expect(
      activitySubscriptionSignal.score(
        { ...post(0), oxyUserId: 'other' },
        buildSignalContext('viewer', context),
      ),
    ).toBe(1);
    expect(
      activitySubscriptionSignal.score(
        {
          ...post(0),
          oxyUserId: 'coauthor-owner',
          activitySubscriptionMatch: true,
          activitySubscriptionAuthorIds: ['bell-author'],
        },
        buildSignalContext('viewer', context),
      ),
    ).toBe(2);
  });
  it.each(['hiddenAuthors', 'mutedAuthors', 'blockedAuthors'] as const)(
    'ignores a %s bell coauthor while preserving another eligible coauthor',
    (field) => {
      const candidate = {
        ...post(0),
        oxyUserId: 'clean-owner',
        activitySubscriptionMatch: true,
        activitySubscriptionAuthorIds: ['bell-author'],
      };
      const ctx = buildSignalContext('viewer', {
        ...context,
        activitySubscribedAuthorIdsSet: new Set(['bell-author', 'eligible']),
        userBehavior: { [field]: ['bell-author'] },
      });
      expect(activitySubscriptionSignal.score(candidate, ctx)).toBe(1);
      expect(
        activitySubscriptionSignal.score(
          { ...candidate, activitySubscriptionAuthorIds: ['bell-author', 'eligible'] },
          ctx,
        ),
      ).toBe(2);
      expect(
        activitySubscriptionSignal.score(
          { ...candidate, activitySubscriptionAuthorIds: undefined },
          ctx,
        ),
      ).toBe(1);
    },
  );
  it('never offsets negative viewer feedback or sensitive content', async () => {
    for (const userBehavior of [
      { hiddenAuthors: ['bell-author'] },
      { mutedAuthors: ['bell-author'] },
      { blockedAuthors: ['bell-author'] },
      { hiddenTopics: ['unwanted'] },
    ]) {
      const candidate = { ...post(0), hashtags: ['unwanted'] };
      expect(
        activitySubscriptionSignal.score(
          candidate,
          buildSignalContext('viewer', { ...context, userBehavior }),
        ),
      ).toBe(1);
    }
    const sensitive = { ...post(0), metadata: { isSensitive: true } };
    expect(activitySubscriptionSignal.score(sensitive, buildSignalContext('viewer', context))).toBe(
      1,
    );
    const ranking = new FeedRankingService();
    expect(
      await ranking.calculatePostScore(sensitive, 'viewer', {
        ...context,
        authoritativeSignals: true,
      }),
    ).toBe(0);
    expect(
      await ranking.calculatePostScore(post(0), 'viewer', {
        ...context,
        authoritativeSignals: true,
        userBehavior: { hiddenAuthors: ['bell-author'] },
      }),
    ).toBe(0);
    const off = await ranking.calculatePostScore(post(0), 'viewer', {
      ...context,
      authoritativeSignals: true,
      enabledSignals: new Set(),
    });
    const on = await ranking.calculatePostScore(post(0), 'viewer', {
      ...context,
      authoritativeSignals: true,
    });
    expect(on / off).toBe(2);
  });
  it('adds supply and priority only to For You, leaving chronological Following and other presets alone', () => {
    expect(
      forYouDefinition.sources.some((ref) => ref.module === 'activitySubscriptions' && ref.enabled),
    ).toBe(true);
    expect(
      forYouDefinition.signals.some(
        (ref) => ref.module === 'activitySubscriptionBoost' && ref.enabled,
      ),
    ).toBe(true);
    for (const definition of [followingDefinition, videosDefinition, exploreDefinition]) {
      expect(definition.sources.some((ref) => ref.module === 'activitySubscriptions')).toBe(false);
      expect(definition.signals.some((ref) => ref.module === 'activitySubscriptionBoost')).toBe(
        false,
      );
    }
    expect(followingDefinition.mode).toBe('chronological');
    const registry = new FeedModuleRegistry();
    registerSignalModules(registry);
    expect(
      buildModuleCatalog(registry).signals.some(
        (signal) => signal.id === 'activitySubscriptionBoost',
      ),
    ).toBe(false);
  });
});
