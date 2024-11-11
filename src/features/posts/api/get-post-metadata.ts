"use server";

// Placeholder for your actual API call
async function getAuthorFromAPI(author_id: string) {
  const response = await fetch(
    process.env.NEXT_PUBLIC_OXY_SERVICES_URL + `/api/users/${author_id}`,
  );
  const data = await response.json();
  return data;
}

export const getPostMetadata = async ({ post_id }: { post_id: string }) => {
  try {
    const response = await fetch(`https://api.oxy.so/mention/posts/${post_id}`);
    const post = await response.json();

    if (!post) {
      throw new Error("Post not found");
    }

    const author = await getAuthorFromAPI(post.author_id);

    return {
      ...post,
      author,
    };
  } catch (error) {
    console.error(error);
    throw error;
  }
};
