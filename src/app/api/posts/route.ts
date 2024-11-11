import { NextResponse } from "next/server";
import { z } from "zod";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type") || undefined;
  const id = searchParams.get("id") || undefined;

  const cursorQuery = searchParams.get("cursor") || undefined;
  const take = Number(searchParams.get("limit")) || 20;

  const skip = cursorQuery ? 1 : 0;
  const cursor = cursorQuery ? { id: cursorQuery } : undefined;

  try {
    const response = await fetch("https://api.oxy.so/mention/posts/");
    const data = (await response.json()) as { posts: any[] };

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

    const nextId = posts.length < take ? undefined : posts[posts.length - 1].id;
    return NextResponse.json({
      posts,
      nextId,
    });
  } catch (error) {
    return NextResponse.error();
  }
}

export async function POST(request: Request) {
  const { post } = (await request.json()) as {
    post: {
      text: string;
      author_id: string;
      in_reply_to_username?: string;
      in_reply_to_status_id?: string;
      quoted_post_id?: string;
    };
  };

  post.text = encodeURIComponent(post?.text);

  const postSchema = z
    .object({
      text: z.string(),
      author_id: z.string().cuid(),
      in_reply_to_username: z.string().optional(),
      in_reply_to_status_id: z.string().cuid().optional(),
      quoted_post_id: z.string().cuid().optional(),
    })
    .strict();

  const zod = postSchema.safeParse(post);

  if (!zod.success) {
    return NextResponse.json(
      {
        message: "Invalid request body",
        error: zod.error.formErrors,
      },
      { status: 400 },
    );
  }

  try {
    const created_post = await prisma.post.create({
      data: {
        ...post,
      },
    });

    if (post.quoted_post_id) {
      await prisma.post.update({
        where: {
          id: post.quoted_post_id,
        },

        data: {
          quote_count: {
            increment: 1,
          },
        },
      });
    }

    return NextResponse.json(created_post, { status: 200 });
  } catch (error: any) {
    return NextResponse.json(
      {
        message: "Something went wrong",
        error: error.message,
      },
      { status: error.errorCode || 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") as string;

  const idSchema = z.string().cuid();
  const zod = idSchema.safeParse(id);

  if (!zod.success) {
    return NextResponse.json(
      {
        message: "Invalid request body",
        error: zod.error.formErrors,
      },
      { status: 400 },
    );
  }

  try {
    await prisma.post.delete({
      where: {
        id,
      },
    });
    return NextResponse.json({
      message: "Post deleted successfully",
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        message: "Something went wrong",
        error: error.message,
      },
      { status: error.errorCode || 500 },
    );
  }
}
