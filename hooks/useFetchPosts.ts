import { useState, useEffect } from "react";
import { fetchData } from "@/utils/api";
import { storeData, getData } from "@/utils/storage";
import { Post } from "@/interfaces/Post";
import { usePostsStore } from "@/store/stores/postStore";
import { Post as PostAPIResponse } from "@/interfaces/Post";

export const useFetchPosts = () => {
  const [posts, setPosts] = useState<Post[]>([]);
  const { getPosts, addPost } = usePostsStore();

  const fetchPosts = async () => {
    try {
      const response = await fetchData("posts");
      const posts = response.posts.map((post: PostAPIResponse) => ({
        id: post.id,
        text: decodeURIComponent(post.text),
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
        created_at: new Date(post.created_at).toLocaleString(),
        quoted_post_id: post.quoted_post_id,
        in_reply_to_status_id: post.in_reply_to_status_id,
        author_id: post.author_id,
        author: {
          ...post.author,
          image: "https://scontent-bcn1-1.xx.fbcdn.net/v/t39.30808-6/463417298_3945442859019280_8807009322776007473_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=6ee11a&_nc_ohc=zXRqATKNOw0Q7kNvgHnyfUU&_nc_oc=AdgYVSd5vfuRV96_nxCmCnemTuCfkgS2YQ_Diu1puFc_h76AbObPG9_eD5rFA5TcRxYnE2mW_ZfJKWuXYtX-Z8ue&_nc_zt=23&_nc_ht=scontent-bcn1-1.xx&_nc_gid=AqvR1nQbgt2nJudR3eAKaLM&oh=00_AYBD3grUDwAE84jgvGS3UmB93xn3odRDqePjARpVj6L2vQ&oe=678C0857",
        },
        likes: post.likes,
        media: post.media,
        quoted_post: post.quoted_post,
        quotes: post.quotes,
        comments: 0,
        bookmarks: 0,
        _count: {
          comments: 0,
          likes: 0,
          quotes: 0,
          reposts: 0,
          bookmarks: 0,
          replies: 0,
        },
      }));
      setPosts(posts);
      await storeData("posts", posts);
      posts.forEach(addPost);
    } catch (error) {
      console.error("Error fetching posts:", error);
      const offlinePosts = await getData("posts");
      if (offlinePosts) {
        setPosts(offlinePosts);
      } else {
        const storedPosts = getPosts();
        setPosts(storedPosts);
      }
    }
  };

  useEffect(() => {
    fetchPosts();
  }, []);

  return posts;
};
