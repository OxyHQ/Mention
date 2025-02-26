import { User } from './User';

interface Author {
  id: string;
  name: {
    first: string;
    last: string;
  };
  username: string;
  avatar: string;
  email: string;
  image: string;
  description: string;
  color: string;
}

export interface Post {
  id: string;
  text: string;
  source: string;
  possibly_sensitive: boolean;
  lang: string;
  created_at: string;
  updated_at: string;
  quoted_post_id: string | null;
  in_reply_to_status_id: string | null;
  userID: string;
  author?: User;
  media: string[];
  quoted_post: Post | null;
  repost_of: string | null;
  isLiked?: boolean;
  isReposted?: boolean;
  isBookmarked?: boolean;
  location?: { type: string; coordinates: [number, number] } | string;
  metadata?: string;
  mentions: string[];
  hashtags: string[];
  replies: string[];
  likes: string[];
  reposts: string[];
  bookmarks: string[];
  isDraft: boolean;
  scheduledFor: string | null;
  status: 'draft' | 'scheduled' | 'published';
  _count?: {
    replies: number;
    likes: number;
    quotes: number;
    reposts: number;
    replies: number;
    bookmarks: number;
  };
}
