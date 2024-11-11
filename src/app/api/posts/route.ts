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

  interface AuthorData {
    id: string;
    name: string;
    username: string;
    email: string;
    role: string;
    avatar: string;
  }

  try {
    const response = await fetch("https://api.oxy.so/mention/posts/");
    const data = await response.json();

    const posts = data.posts;

    const authorIds = posts.map((post: any) => post.author.id);
    const authorData: AuthorData[] = await fetch(
      process.env.NEXT_PUBLIC_OXY_SERVICES_URL +
        `/api/users?ids=${authorIds.join(",")}`,
    )
      .then((response) => response.json() as Promise<AuthorData[]>)
      .catch((error) => {
        console.error("Error:", error);
        return []; // return an empty array in case of error
      });

    const postsWithAuthorData = posts.map((post: any) => {
      const author = authorData.find((author) => author.id === post.author.id);
      return {
        ...post,
        author,
      };
    });

    const postsWithAuthorDataResolved = await Promise.all(postsWithAuthorData);

    const nextId = posts.length < take ? undefined : posts[posts.length - 1].id;
    return NextResponse.json({
      posts: postsWithAuthorDataResolved,
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
    const response = await fetch("https://api.oxy.so/mention/posts/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(post),
    });

    const created_post = await response.json();

    if (post.quoted_post_id) {
      await fetch(`https://api.oxy.so/mention/posts/${post.quoted_post_id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quote_count: {
            increment: 1,
          },
        }),
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
    await fetch(`https://api.oxy.so/mention/posts/${id}`, {
      method: "DELETE",
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
