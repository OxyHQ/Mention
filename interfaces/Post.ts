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
  author?: Author | null;
  media: any[];
  quoted_post: any | null;
  isLiked?: boolean;
  _count: {
    comments: number;
    likes: number;
    quotes: number;
    reposts: number;
    replies: number;
    bookmarks: number;
  };
}
