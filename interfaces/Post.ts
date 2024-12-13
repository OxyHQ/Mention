export interface Post {
  id: string;
  user: {
    name: string;
    avatar: string;
    username: string;
  };
  content: string;
  timestamp: string;
  likes: number;
  reposts: number;
  replies: number;
}
