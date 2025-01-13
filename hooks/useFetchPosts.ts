import { useState, useEffect } from "react";
import { fetchData } from "@/utils/api";
import { storeData } from "@/utils/storage";
import { Post } from "@/interfaces/Post";
import { usePostsStore } from "@/store/stores/postStore";

interface PostAPIResponse {
  id: string;
  text: string;
  created_at: string;
  author: {
    name: string;
    image: string;
    username: string;
  };
}

export const useFetchPosts = () => {
  const [posts, setPosts] = useState<Post[]>([]);
  const { getPosts, addPost } = usePostsStore();

  const fetchPosts = async () => {
    try {
      const response = await fetchData("posts");
      const posts = response.posts.map((post: PostAPIResponse) => ({
        id: post.id,
        user: {
          name: post.author?.name || "Unknown",
          avatar: post.author?.image || "https://via.placeholder.com/50",
          username: post.author?.username || "unknown",
        },
        content: decodeURIComponent(post.text),
        timestamp: new Date(post.created_at).toLocaleTimeString(),
        time: post.created_at,
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
