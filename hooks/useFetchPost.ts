import { useState, useEffect } from "react";
import { fetchData } from "@/utils/api";
import { Post } from "@/interfaces/Post";
import { usePostsStore } from "@/store/stores/postStore";

export const useFetchPost = (id: string) => {
  const [post, setPost] = useState<Post | null>(null);
  const { getPostById } = usePostsStore();

  const fetchPost = async () => {
    try {
      const response = await fetchData(`posts/${id}`);
      setPost(response.post);
    } catch (error) {
      console.error("Error fetching post:", error);
      const offlinePost = getPostById(id);
      if (offlinePost) {
        setPost(offlinePost);
      }
    }
  };

  useEffect(() => {
    fetchPost();
  }, [id]);

  return post;
};
