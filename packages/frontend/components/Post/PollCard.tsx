import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { pollService } from '@/services/pollService';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';

interface PollCardProps {
  pollId: string;
  width?: number;
}

const PollCard: React.FC<PollCardProps> = ({ pollId, width = 280 }) => {
  const { user } = useAuth();
  const theme = useTheme();
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
    <View style={[styles.card, { width, backgroundColor: theme.colors.background }]}>
      <Loading size="small" style={{ flex: undefined }} />
    </View>
  );

  if (error || !poll) return null;

  return (
    <View style={[styles.card, { width, backgroundColor: theme.colors.background }]}>
      <Text style={[styles.question, { color: theme.colors.text }]} numberOfLines={3}>{poll.question}</Text>
      <View style={{ gap: 8 }}>
        {(poll.options || []).map((opt: any) => {
          const votes = opt.votes?.length || 0;
          const pct = totalVotes > 0 ? (votes / totalVotes) : 0;
          return (
            <Pressable
              key={opt._id}
              onPress={() => handleVote(opt._id)}
              disabled={ended || (hasVoted && !poll.isMultipleChoice) || voting}
              style={({ pressed }) => [
                styles.option,
                { borderColor: theme.colors.border, backgroundColor: theme.colors.background },
                pressed ? { opacity: 0.9 } : null,
                ended || (hasVoted && !poll.isMultipleChoice) ? { opacity: 0.9 } : null,
              ]}
            >
              <View style={[styles.progressBg, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <View style={[styles.progressFill, { width: `${pct * 100}%`, backgroundColor: `${theme.colors.primary}40` }]} />
              </View>
              <View style={styles.optionRow}>
                <Text style={[styles.optionText, { color: theme.colors.text }]} numberOfLines={1}>{opt.text}</Text>
                <Text style={[styles.optionPct, { color: theme.colors.text }]}>{Math.round(pct * 100)}%</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.metaRow}>
        <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>{totalVotes} votes</Text>
        <Text style={[styles.dot, { color: theme.colors.textSecondary }]}>·</Text>
        <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>{ended ? 'Ended' : 'Active'}</Text>
      </View>
    </View>
  );
};

export default PollCard;

const styles = StyleSheet.create({
  card: {
    padding: 12,
    flex: 1,
    width: '100%',
  },
  question: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  option: {
    position: 'relative',
    borderWidth: 1,
    borderRadius: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
    overflow: 'hidden',
  },
  progressBg: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '100%',
  },
  progressFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  optionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  optionText: {
    fontSize: 14,
    flex: 1,
    marginRight: 8,
  },
  optionPct: {
    fontSize: 14,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
  },
  metaText: {
    fontSize: 12,
  },
  dot: {
  },
});

