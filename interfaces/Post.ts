interface Author {
  id: string;
  name: string;
  username: string;
  email: string;
  image: string;
  description: string;
  color: string;
}

export interface Post {
  id: string;
  text: string;
  source: string;
  in_reply_to_user_id: string | null;
  in_reply_to_username: string | null;
  is_quote_status: boolean;
  quoted_status_id: string | null;
  quote_count: number;
  reply_count: number;
  repost_count: number;
  favorite_count: number;
  possibly_sensitive: boolean;
  lang: string;
  created_at: string;
  quoted_post_id: string | null;
  in_reply_to_status_id: string | null;
  author_id: string;
  author: Author;
  likes: number;
  replies: number;
  media: any[];
  reposts: number;
  quoted_post: any | null;
  quotes: number;
  comments: number;
  bookmarks: number;
  _count: {
    comments: number;
    likes: number;
    quotes: number;
    reposts: number;
    replies: number;
    bookmarks: number;
  };
}