import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { pollService } from '@/services/pollService';
import { useAuth } from '@oxyhq/services';
import { cn } from '@/lib/utils';

interface PollCardProps {
  pollId: string;
  width?: number;
}

const PollCard: React.FC<PollCardProps> = ({ pollId, width = 280 }) => {
  const { user } = useAuth();
  const [poll, setPoll] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPoll = async () => {
    try {
      setLoading(true);
      const res = await pollService.getPoll(pollId);
      setPoll(res.data);
      setError(null);
    } catch (e: any) {
      setError('Failed to load poll');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPoll();
  }, [pollId]);

  const totalVotes = useMemo(() => {
    if (!poll) return 0;
    return poll.options.reduce((sum: number, opt: any) => sum + (opt.votes?.length || 0), 0);
  }, [poll]);

  const hasVoted = useMemo(() => {
    if (!poll || !user?.id) return false;
    return poll.options.some((opt: any) => (opt.votes || []).includes(user.id));
  }, [poll, user?.id]);

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
      await pollService.vote(pollId, optionId);
      await loadPoll();
    } catch (e) {
      // swallow for now
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
        {(poll.options || []).map((opt: any) => {
          const votes = opt.votes?.length || 0;
          const pct = totalVotes > 0 ? (votes / totalVotes) : 0;
          return (
            <Pressable
              key={opt._id}
              onPress={() => handleVote(opt._id)}
              disabled={ended || (hasVoted && !poll.isMultipleChoice) || voting}
              className="border-border bg-background"
              style={({ pressed }) => [
                styles.option,
                pressed ? { opacity: 0.9 } : null,
                ended || (hasVoted && !poll.isMultipleChoice) ? { opacity: 0.9 } : null,
              ]}
            >
              <View className="absolute left-0 top-0 bottom-0 w-full bg-secondary">
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
