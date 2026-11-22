import { tokens } from '@oxy.so/bloom/styles';
import { PollSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Pressable, StyleSheet } from 'react-native';
import { StatBar } from '@oxy.so/bloom/stat-bar';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import { pollService, PollContractError, type PollDetailOption } from '@/services/pollService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

import {
  Card,
  type Child,
  Embed,
  HStack,
  RawText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const logger = createLogger('PollCard');

/** The poll's outlined card, filling its cell. */
function pollCard(...children: Child[]) {
  return Card(...children)
    .style('outline')
    .radius('lg')
    .padding('all', 'md')
    .frame({ width: 'full' })
    .flex('1');
}

interface PollCardProps {
  pollId: string;
}

/** Whether a poll's end time has passed. Outside the component: it reads the clock. */
function hasEnded(endsAt: string | undefined): boolean {
  if (!endsAt) return false;
  const time = new Date(endsAt).getTime();
  return Number.isFinite(time) && time < Date.now();
}

/**
 * The poll attached to a post, read through React Query rather than fetched on
 * mount: a feed row is mounted, recycled and re-mounted many times, and a
 * per-mount fetch made every one of those a request for the same poll
 * (#1103). One cached answer per viewer and poll; a vote writes its own
 * response into that entry.
 */
const PollCard: React.FC<PollCardProps> = ({ pollId }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = viewerQueryKeys.poll(user?.id, pollId);
  const {
    data: poll,
    isLoading: loading,
    isError,
  } = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return (await pollService.getPoll(pollId)).data;
      } catch (err) {
        logger.error('Failed to load poll', err);
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const [voting, setVoting] = useState(false);
  const error = isError ? 'Failed to load poll' : null;

  // `voteCount` is unconditional and always a number — see `PollDetailOption`
  // in `@mention/shared-types`. It used to be an array of voter ids for a
  // visible poll and a bare count for an anonymous one under the SAME field,
  // which is what made this sum silently read zero and `hasVoted` throw the
  // first time an anonymous poll got a vote.
  const totalVotes = useMemo(() => {
    if (!poll) return 0;
    return poll.options.reduce((sum: number, opt: PollDetailOption) => sum + opt.voteCount, 0);
  }, [poll]);

  // The viewer's own selection, never another voter's — carried explicitly
  // rather than reconstructed from a voter list this response never contains.
  const hasVoted = useMemo(() => {
    if (!poll) return false;
    return poll.viewerSelectedOptionIds.length > 0;
  }, [poll]);

  const ended = hasEnded(poll?.endsAt);

  const handleVote = async (optionId: string) => {
    if (voting || ended) return;
    if (hasVoted && !poll?.isMultipleChoice) return;
    try {
      setVoting(true);
      // Apply the vote's own response directly — it is already the poll's
      // canonical post-vote state, so a second GET right behind it only ever
      // reread what this response already carried.
      const { data } = await pollService.vote(pollId, optionId);
      queryClient.setQueryData(queryKey, data);
    } catch (err) {
      logger.error('Failed to record vote', err);
      const message =
        err instanceof PollContractError
          ? 'The vote could not be understood by the app'
          : 'Failed to record your vote';
      toast.error(message);
    } finally {
      setVoting(false);
    }
  };

  if (loading) return toElement(pollCard(Embed(<PollSkeleton />)));

  if (error || !poll) return null;

  const locked = ended || (hasVoted && !poll.isMultipleChoice);

  return toElement(
    pollCard(
      RawText(poll.question)
        .foreground('foreground')
        .font('16')
        .leading('normal')
        .weight('semibold')
        .margin('bottom', 'sm')
        .lines(3),
      VStack(
        Embed(
          poll.options.map((opt: PollDetailOption) => {
            const pct = totalVotes > 0 ? opt.voteCount / totalVotes : 0;
            return (
              <Pressable
                key={opt._id}
                onPress={() => handleVote(opt._id)}
                hitSlop={tokens.hitSlop.md}
                disabled={locked || voting}
                accessibilityRole="button"
                accessibilityLabel={`${opt.text}, ${Math.round(pct * 100)}%`}
                style={({ pressed }) => [
                  styles.option,
                  pressed || locked ? styles.optionDimmed : null,
                ]}
              >
                <StatBar
                  label={opt.text}
                  value={pct * 100}
                  max={100}
                  icon={toElement(
                    RawText(Math.round(pct * 100), '%')
                      .foreground('foreground')
                      .font('14')
                      .leading('20px')
                      .weight('semibold'),
                  )}
                />
              </Pressable>
            );
          }),
        ),
      ).spacing('xs'),
      HStack(
        RawText(totalVotes, ' votes').foreground('muted').font('xs').leading('16px'),
        RawText('·').foreground('muted'),
        RawText(ended ? 'Ended' : 'Active')
          .foreground('muted')
          .font('xs')
          .leading('16px'),
      )
        .spacing('6')
        .margin('top', '10'),
    ),
  );
};

export default PollCard;

const styles = StyleSheet.create({
  // A tap target around the option's labelled bar — the bar itself is Bloom's
  // `StatBar` (label, share, `Meter`), so the row only owns the press.
  option: {
    paddingVertical: 6,
  },
  optionDimmed: {
    opacity: 0.9,
  },
});
