import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import { pollService, PollContractError, type PollDetail, type PollDetailOption } from '@/services/pollService';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

const logger = createLogger('PollCard');

interface PollCardProps {
  pollId: string;
  width?: number;
}

const PollCard: React.FC<PollCardProps> = ({ pollId, width = 280 }) => {
  const [poll, setPoll] = useState<PollDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPoll = useCallback(async () => {
    try {
      setLoading(true);
      const res = await pollService.getPoll(pollId);
      setPoll(res.data);
      setError(null);
    } catch (err) {
      logger.error('Failed to load poll', err);
      setError('Failed to load poll');
    } finally {
      setLoading(false);
    }
  }, [pollId]);

  useEffect(() => {
    void loadPoll();
  }, [loadPoll]);

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

  const ended = useMemo(() => {
    if (!poll?.endsAt) return false;
    try {
      return new Date(poll.endsAt).getTime() < Date.now();
    } catch { return false; }
  }, [poll?.endsAt]);

  const handleVote = async (optionId: string) => {
    if (voting || ended) return;
    if (hasVoted && !poll?.isMultipleChoice) return;
    try {
      setVoting(true);
      // Apply the vote's own response directly — it is already the poll's
      // canonical post-vote state, so a second GET right behind it only ever
      // reread what this response already carried.
      const { data } = await pollService.vote(pollId, optionId);
      setPoll(data);
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
    <View className="flex-1 w-full p-3 bg-background" style={{ width }}>
      <Loading className="text-primary" size="small" style={{ flex: undefined }} />
    </View>
  );

  if (error || !poll) return null;

  return (
    <View className="flex-1 w-full p-3 bg-background" style={{ width }}>
      <Text className="text-foreground text-base font-semibold mb-2" numberOfLines={3}>{poll.question}</Text>
      <View className="gap-2">
        {poll.options.map((opt: PollDetailOption) => {
          const pct = totalVotes > 0 ? (opt.voteCount / totalVotes) : 0;
          return (
            <Pressable
              key={opt._id}
              onPress={() => handleVote(opt._id)}
              hitSlop={HIT_SLOP_MD}
              disabled={ended || (hasVoted && !poll.isMultipleChoice) || voting}
              className="border-border bg-background"
              style={({ pressed }) => [
                styles.option,
                pressed ? { opacity: 0.9 } : null,
                ended || (hasVoted && !poll.isMultipleChoice) ? { opacity: 0.9 } : null,
              ]}
            >
              <View className="absolute left-0 top-0 bottom-0 w-full bg-muted">
                <View className="absolute left-0 top-0 bottom-0 bg-primary/25" style={{ width: `${pct * 100}%` }} />
              </View>
              <View className="flex-row justify-between items-center">
                <Text className="text-foreground text-sm flex-1 mr-2" numberOfLines={1}>{opt.text}</Text>
                <Text className="text-foreground text-sm font-semibold">{Math.round(pct * 100)}%</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      <View className="flex-row gap-1.5 mt-2.5">
        <Text className="text-muted-foreground text-xs">{totalVotes} votes</Text>
        <Text className="text-muted-foreground">{'\u00B7'}</Text>
        <Text className="text-muted-foreground text-xs">{ended ? 'Ended' : 'Active'}</Text>
      </View>
    </View>
  );
};

export default PollCard;

const styles = StyleSheet.create({
  option: {
    position: 'relative',
    borderWidth: 1,
    borderRadius: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
    overflow: 'hidden',
  },
});
