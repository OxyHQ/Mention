import axios from "axios";
import { deleteHashtags } from "@/features/explore/api/delete-hashtags";
import { retrieveHashtagsFromPost } from "@/features/explore/api/retrieve-hashtags-from-post";
import { prisma } from "@/lib/prisma";

export const deletePost = async (postId: string) => {
  try {
    const post = await prisma.post.findUnique({
      where: {
        id: postId,
      },
      select: {
        text: true,
      },
    });

    if (post) {
      const hashtags = retrieveHashtagsFromPost(post.text);
      if (hashtags) {
        await deleteHashtags(hashtags);
      }
    }

    const { data } = await axios.delete(`/api/posts?id=${postId}`);

    return data;
  } catch (error: any) {
    console.log(error);
  }
};
