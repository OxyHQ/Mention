import { NextResponse } from "next/server";
import { z } from "zod";

export async function POST(request: Request) {
  const { post_id, user_id } = (await request.json()) as {
    post_id: string;
    user_id: string;
  };

  const repostSchema = z
    .object({
      post_id: z.string().cuid(),
      user_id: z.string().cuid(),
    })
    .strict();

  const zod = repostSchema.safeParse({ post_id, user_id });

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
    const response = await fetch(`https://api.oxy.so/mention/posts/${post_id}/reposts`, {
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
