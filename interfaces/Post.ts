export interface Post {
  id: string;
  user: {
    name: string;
    avatar: string;
    username: string;
  };
  timestamp: string;
  avatar: string;
  name: string;
  username: string;
  content: string;
  time: string;
  likes: number;
  reposts: number;
  replies: number;
  isReply?: boolean;
  hasMedia?: boolean;
  isLiked?: boolean;
  showActions?: boolean;
  images?: string[];
  poll?: { question: string; options: string[] };
  location?: string;
  quotedPost?: boolean;
}