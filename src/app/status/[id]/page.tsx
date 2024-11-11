import { getPostMetadata } from "@/features/posts/api/get-post-metadata";
import { Metadata } from "next";

interface Post {
  text: string;
  author: unknown;
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const post = await getPostMetadata({ post_id: params.id });

  return {
    title: ` on Mention: "${decodeURIComponent(post?.text as string)}"`,
    description: decodeURIComponent(post?.text as string),
  };
}

const StatusPage = async ({ params }: { params: { id: string } }) => {
  const post = await getPostMetadata({ post_id: params.id });

  return (
    <div>
      <h1>{decodeURIComponent(post?.text as string)}</h1>
    </div>
  );
};

export default StatusPage;
