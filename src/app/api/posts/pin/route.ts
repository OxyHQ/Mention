import { NextResponse } from "next/server";
import { z } from "zod";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const user_id = searchParams.get("user_id") || undefined;

  const userSchema = z.string().nonempty();
  const zod = userSchema.safeParse(user_id);

  if (!zod.success) {
    return NextResponse.json({ error: zod.error }, { status: 400 });
  }

  try {
    const response = await fetch(`https://api.oxy.so/mention/posts?user_id=${user_id}`);
    const user = await response.json();

    return NextResponse.json(user, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const { post_id, user_id } = (await request.json()) as {
    post_id: string;
    user_id: string;
  };

  const userSchema = z
    .object({
      post_id: z.string(),
      user_id: z.string(),
    })
    .strict();

  const zod = userSchema.safeParse({ post_id, user_id });

  if (!zod.success) {
    return NextResponse.json({ error: zod.error }, { status: 400 });
  }

  try {
    const response = await fetch(`https://api.oxy.so/mention/posts/${post_id}/pin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id }),
    });

    const result = await response.json();

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const { id } = (await request.json()) as { id: string };

  const userSchema = z.string();

  const zod = userSchema.safeParse(id);

  if (!zod.success) {
    return NextResponse.json({ error: zod.error }, { status: 400 });
  }

  try {
    const response = await fetch(`https://api.oxy.so/mention/posts/${id}/unpin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const result = await response.json();

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
