import { NextResponse } from "next/server";
import { z } from "zod";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const user_id = searchParams.get("user_id") || undefined;

  const userIdSchema = z.string().cuid();
  const zod = userIdSchema.safeParse(user_id);

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
    const response = await fetch(`https://api.oxy.so/mention/posts?user_id=${user_id}`);
    const posts = await response.json();

    return NextResponse.json(posts, { status: 200 });
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

export async function POST(request: Request) {
  const { post_id, user_id } = (await request.json()) as {
    post_id: string;
    user_id: string;
  };

  const likeSchema = z
    .object({
      post_id: z.string().cuid(),
      user_id: z.string().cuid(),
    })
    .strict();

  const zod = likeSchema.safeParse({ post_id, user_id });

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
    const response = await fetch(`https://api.oxy.so/mention/posts/${post_id}/likes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id }),
    });

    const result = await response.json();

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({
      message: "Something went wrong",
      error: error.message,
    });
  }
}
