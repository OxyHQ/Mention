import { Metadata } from "next";
import { notFound } from "next/navigation";

import { getPost } from "@/features/posts/api/get-post";
import { Post } from "@/features/posts/types";
import { PostDetails } from "@/features/posts/components/post-details";

type PageProps = {
  params: {
    id: string;
  };
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const post = (await getPost(params.id)) as Post;

  if (!post) {
    return notFound();
  }

  return {
    title: ` on Mention: "${decodeURIComponent(post?.text as string)}"`,
    description: decodeURIComponent(post?.text as string),
  };
}

export default async function Page({ params }: PageProps) {
  const post = (await getPost(params.id)) as Post;

  if (!post) {
    return notFound();
  }

  return <PostDetails post={post} />;
}
