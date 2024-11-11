import axios from "axios";

export const getPosts = async ({
  pageParam = "",
  limit = 20,
  type,
  id,
}: {
  pageParam?: string | unknown;
  limit?: number;
  type?: string;
  id?: string;
}) => {
  try {
    const { data } = await axios.get(
      `/api/posts?cursor=${pageParam}&limit=${limit}${
        type ? `&type=${type}` : ""
      }${id ? `&id=${id}` : ""}`,
    );

    const posts = data.posts.map((post: any) => ({
      id: post.id,
      text: post.text,
      author: post.author,
      source: post.source,
      in_reply_to_user_id: post.in_reply_to_user_id,
      in_reply_to_username: post.in_reply_to_username,
      is_quote_status: post.is_quote_status,
      quoted_status_id: post.quoted_status_id,
      quote_count: post.quote_count,
      reply_count: post.reply_count,
      repost_count: post.repost_count,
      favorite_count: post.favorite_count,
      possibly_sensitive: post.possibly_sensitive,
      lang: post.lang,
      created_at: post.created_at,
      quoted_post_id: post.quoted_post_id,
      in_reply_to_status_id: post.in_reply_to_status_id,
      likes: post.likes,
      media: post.media,
      reposts: post.reposts,
      quoted_post: post.quoted_post,
      quotes: post.quotes,
      comments: post.comments,
      bookmarks: post.bookmarks,
      _count: post._count,
      view_count: post.view_count,
    }));

    return { posts, nextId: data.nextId };
  } catch (error: any) {
    return error.response.data;
  }
};
