import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { Loading } from '@oxy.so/bloom/loading';
import { StatBar } from '@oxy.so/bloom/stat-bar';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import { pollService, PollContractError, type PollDetailOption } from '@/services/pollService';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

const logger = createLogger('PollCard');

interface PollCardProps {
  pollId: string;
  width?: number;
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
const PollCard: React.FC<PollCardProps> = ({ pollId, width = 280 }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = viewerQueryKeys.poll(user?.id, pollId);
  const { data: poll, isLoading: loading, isError } = useQuery({
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
      const message = err instanceof PollContractError
        ? 'The vote could not be understood by the app'
        : 'Failed to record your vote';
      toast.error(message);
    } finally {
      setVoting(false);
    }
  };

  if (loading) return (
    <Card variant="outlined" radius="radius-16" className="flex-1 w-full p-3" style={{ width }}>
      <Loading className="text-primary" size="small" style={{ flex: undefined }} />
    </Card>
  );

  if (error || !poll) return null;

  const locked = ended || (hasVoted && !poll.isMultipleChoice);

  return (
    <Card variant="outlined" radius="radius-16" className="flex-1 w-full p-3" style={{ width }}>
      <Text className="text-foreground text-base font-semibold mb-2" numberOfLines={3}>{poll.question}</Text>
      <View className="gap-1">
        {poll.options.map((opt: PollDetailOption) => {
          const pct = totalVotes > 0 ? (opt.voteCount / totalVotes) : 0;
          return (
            <Pressable
              key={opt._id}
              onPress={() => handleVote(opt._id)}
              hitSlop={HIT_SLOP_MD}
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
                icon={<Text className="text-foreground text-sm font-semibold">{Math.round(pct * 100)}%</Text>}
              />
            </Pressable>
          );
        })}
      </View>
      <View className="flex-row gap-1.5 mt-2.5">
        <Text className="text-muted-foreground text-xs">{totalVotes} votes</Text>
        <Text className="text-muted-foreground">{'\u00B7'}</Text>
        <Text className="text-muted-foreground text-xs">{ended ? 'Ended' : 'Active'}</Text>
      </View>
    </Card>
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
