
export interface Trend {
  id: string;
  text: string;
  hashtag: string;
  score: number;
  created_at: string;
  direction?: 'up' | 'down' | 'flat';
}
