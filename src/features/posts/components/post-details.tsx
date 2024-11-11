"use client";
import { usePathname } from "next/navigation";

import { LoadingSpinner } from "@/components/elements/loading-spinner";
import { TryAgain } from "@/components/elements/try-again";
import { CreatePostWrapper, ReplyingTo } from "@/features/create-post";
import {
  IPost,
  Comments,
  QuotedPost,
  PostActions,
  PostAuthor,
  PostCreationDate,
  PostMedia,
  PostStatistics,
  usePost,
} from "@/features/posts";
import getPost from "@/features/posts/api/get-post";

import styles from "./styles/post-details.module.scss";

export const PostDetails = ({
  initialPost,
}: {
  initialPost: IPost | undefined;
}) => {
  const pathname = usePathname();
  const postId = pathname.split(`/`)[2];

  const {
    data: post,
    isPending,
    isError,
  } = usePost({
    id: postId,
    initialData: initialPost,
  });

  if (isPending) return <LoadingSpinner />;

  if (isError) return <TryAgain />;

  return (
    <div className={styles.container}>
      <div className={styles.postDetails}>
        <PostAuthor post={post} />
        {post?.in_reply_to_status_id && (
          <ReplyingTo
            username={post?.in_reply_to_username}
            id={post?.author?.id}
          />
        )}

        <div className={styles.post}>
          {post?.text && (
            <div className={styles.text}>{decodeURIComponent(post?.text)}</div>
          )}
          {post?.media?.length > 0 && (
            <div className={styles.media}>
              <PostMedia media={post?.media} postId={post?.id} />
            </div>
          )}

          {post?.quoted_post && (
            <div className={styles.quotedPost}>
              <QuotedPost post={post?.quoted_post} />
            </div>
          )}
        </div>

        <PostCreationDate date={post?.created_at} link={post?.id} />
        <PostStatistics
          repost_count={post?._count?.reposts}
          quote_count={post?._count?.quotes}
          likes_count={post?._count?.likes}
          bookmarks_count={post?._count?.bookmarks}
        />
        <div className={styles.postActions}>
          <PostActions post={post} />
        </div>
      </div>
      <CreatePostWrapper
        in_reply_to_username={post?.author?.username}
        in_reply_to_status_id={post?.id}
      />
      <Comments postId={post?.id} />
    </div>
  );
};
