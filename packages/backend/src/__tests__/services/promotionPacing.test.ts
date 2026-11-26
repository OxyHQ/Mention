import { describe, expect, it } from 'bun:test';
import {
  isAheadOfSchedule,
  promotionMultiplier,
  scheduledImpressions,
} from '../../services/monetization/promotion/pacing';
import { promotionSignal } from '../../services/feed/ranking/signals/promotion';

const config = { pacingFloorShare: 0.05, maxMultiplier: 3, aheadSlackShare: 0.1 };
const startsAt = new Date('2026-12-01T00:00:00Z');
const endsAt = new Date('2026-12-02T00:00:00Z'); // 24 h window
const at = (hours: number) => new Date(startsAt.getTime() + hours * 3_600_000);
const progress = (deliveredImpressions: number) => ({
  purchasedImpressions: 1000,
  deliveredImpressions,
  startsAt,
  endsAt,
});

describe('promotion pacing', () => {
  it('schedules a linear spend over the window, floored so a new promotion is not on pace at zero', () => {
    expect(scheduledImpressions(progress(0), at(12), config)).toBe(500);
    expect(scheduledImpressions(progress(0), at(0), config)).toBe(50);
    expect(scheduledImpressions(progress(0), at(48), config)).toBe(1000);
  });

  it('lifts a promotion that is behind its schedule, to the ceiling, and not at all when on pace', () => {
    expect(promotionMultiplier(progress(0), at(12), config)).toBe(3);
    expect(promotionMultiplier(progress(250), at(12), config)).toBe(2);
    expect(promotionMultiplier(progress(500), at(12), config)).toBe(1);
    expect(promotionMultiplier(progress(900), at(12), config)).toBe(1);
  });

  it('sits a promotion out once it is well ahead of its schedule, and brings it back as the schedule catches up', () => {
    expect(isAheadOfSchedule(progress(599), at(12), config)).toBe(false);
    expect(isAheadOfSchedule(progress(600), at(12), config)).toBe(true);
    expect(isAheadOfSchedule(progress(600), at(18), config)).toBe(false);
  });
});

describe('promotion signal', () => {
  const enabled = { enabledSignals: new Set(['promotion']) } as never;
  const disabled = { enabledSignals: new Set<string>() } as never;

  it('is neutral for an unpromoted post, and for a feed that did not enable it', () => {
    expect(promotionSignal.score({}, enabled)).toBe(1);
    expect(promotionSignal.score({ promotionBoost: 2.5 }, disabled)).toBe(1);
  });

  it('applies the multiplier the source attached when the feed enabled it', () => {
    expect(promotionSignal.score({ promotionBoost: 2.5 }, enabled)).toBe(2.5);
  });
});
