import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `PollVoteService` is the SINGLE authority for recording a poll vote, shared by
 * the local HTTP vote route and the inbound ActivityPub poll-vote handler. These
 * pin its contract: the ATOMIC dedup guard it issues (so a duplicate never
 * double-counts), closed-poll rejection, unknown-option/poll handling, and the
 * single-vs-multiple-choice branch — the same guarantees both callers rely on.
 *
 * The `Poll` model is stubbed with controllable output; assertions read the
 * `findOneAndUpdate` filter to prove the dedup guard is present (MongoDB provides
 * the atomicity).
 */

const { pollFindById, pollFindOneAndUpdate } = vi.hoisted(() => ({
  pollFindById: vi.fn(),
  pollFindOneAndUpdate: vi.fn(),
}));

vi.mock('../../models/Poll', () => ({
  default: { findById: pollFindById, findOneAndUpdate: pollFindOneAndUpdate },
  Poll: { findById: pollFindById, findOneAndUpdate: pollFindOneAndUpdate },
}));

import { pollVoteService } from '../../services/PollVoteService';

const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2000-01-01T00:00:00.000Z');

/** A lean-ish poll doc; `_id`/option `_id` expose `.toString()` the service uses. */
function poll(overrides: {
  isMultipleChoice?: boolean;
  endsAt?: Date;
  options?: Array<{ id: string; text: string; votes: string[] }>;
}) {
  const options = (overrides.options ?? [
    { id: 'opt-red', text: 'Red', votes: [] },
    { id: 'opt-blue', text: 'Blue', votes: [] },
  ]).map((o) => ({ _id: { toString: () => o.id }, text: o.text, votes: o.votes }));
  return {
    _id: { toString: () => 'poll1' },
    isMultipleChoice: overrides.isMultipleChoice ?? false,
    endsAt: overrides.endsAt ?? FUTURE,
    options,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordVoteByOptionText — resolve option by name', () => {
  it('records a single-choice vote with a dedup guard on the voter, and returns the updated poll', async () => {
    pollFindById.mockResolvedValue(poll({}));
    const updated = { _id: 'poll1' };
    pollFindOneAndUpdate.mockResolvedValue(updated);

    const result = await pollVoteService.recordVoteByOptionText('poll1', 'Blue', 'voter-1');

    expect(result).toEqual({ ok: true, poll: updated });
    // The atomic filter carries the one-per-voter dedup guard (voted on NO option yet).
    expect(pollFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'poll1', 'options._id': 'opt-blue', 'options.votes': { $ne: 'voter-1' } },
      { $push: { 'options.$.votes': 'voter-1' } },
      { new: true },
    );
  });

  it('is a no-op (already_voted) when the voter already voted — no double count', async () => {
    // The snapshot shows the voter already on an option; the atomic update matches
    // nothing (returns null) → the service reports already_voted, never re-pushing.
    pollFindById.mockResolvedValue(poll({ options: [
      { id: 'opt-red', text: 'Red', votes: ['voter-1'] },
      { id: 'opt-blue', text: 'Blue', votes: [] },
    ] }));
    pollFindOneAndUpdate.mockResolvedValue(null);

    const result = await pollVoteService.recordVoteByOptionText('poll1', 'Blue', 'voter-1');

    expect(result).toEqual({ ok: false, reason: 'already_voted' });
  });

  it('rejects a vote after the poll has ended (no update issued)', async () => {
    pollFindById.mockResolvedValue(poll({ endsAt: PAST }));

    const result = await pollVoteService.recordVoteByOptionText('poll1', 'Blue', 'voter-1');

    expect(result).toEqual({ ok: false, reason: 'poll_ended' });
    expect(pollFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('reports option_not_found when no option matches the name', async () => {
    pollFindById.mockResolvedValue(poll({}));

    const result = await pollVoteService.recordVoteByOptionText('poll1', 'Green', 'voter-1');

    expect(result).toEqual({ ok: false, reason: 'option_not_found' });
    expect(pollFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('reports poll_not_found when the poll is gone', async () => {
    pollFindById.mockResolvedValue(null);

    const result = await pollVoteService.recordVoteByOptionText('poll1', 'Blue', 'voter-1');

    expect(result).toEqual({ ok: false, reason: 'poll_not_found' });
  });

  it('uses the per-option $elemMatch dedup guard for a multiple-choice poll', async () => {
    pollFindById.mockResolvedValue(poll({ isMultipleChoice: true }));
    pollFindOneAndUpdate.mockResolvedValue({ _id: 'poll1' });

    await pollVoteService.recordVoteByOptionText('poll1', 'Blue', 'voter-1');

    expect(pollFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: 'poll1',
        'options._id': 'opt-blue',
        options: { $not: { $elemMatch: { _id: 'opt-blue', votes: 'voter-1' } } },
      },
      { $push: { 'options.$.votes': 'voter-1' } },
      { new: true },
    );
  });
});

describe('recordVoteByOptionId — resolve option by id (HTTP route)', () => {
  it('records a vote resolved by the option id', async () => {
    pollFindById.mockResolvedValue(poll({}));
    pollFindOneAndUpdate.mockResolvedValue({ _id: 'poll1' });

    const result = await pollVoteService.recordVoteByOptionId('poll1', 'opt-red', 'voter-9');

    expect(result.ok).toBe(true);
    expect(pollFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'poll1', 'options._id': 'opt-red', 'options.votes': { $ne: 'voter-9' } },
      { $push: { 'options.$.votes': 'voter-9' } },
      { new: true },
    );
  });
});
