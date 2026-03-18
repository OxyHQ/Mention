export interface Trend {
  id: string;
  type: 'hashtag' | 'topic' | 'entity';
  text: string;
  hashtag: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  rank: number;
  created_at: string;
  direction: 'up' | 'down' | 'flat';
}
