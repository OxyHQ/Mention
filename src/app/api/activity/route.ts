import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const idSchema = z.string().cuid().optional();
const limitSchema = z.string().regex(/^\d+$/).optional();

async function fetchUserData(ids: string[]) {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_OXY_SERVICES_URL}/api/users?ids=${ids.join(",")}`,
  );
  return response.json() as Promise<
    { id: string; name: string; avatar: string }[]
  >;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") || undefined;
  const limit = searchParams.get("limit") || undefined;

  const zodId = idSchema.safeParse(id);
  const zodLimit = limitSchema.safeParse(limit);

  if (!zodId.success) {
    return NextResponse.json(zodId.error, { status: 400 });
  }

  if (!zodLimit.success) {
    return NextResponse.json(zodLimit.error, { status: 400 });
  }

  try {
    const followers = await prisma.profile.findMany({
      where: { followers: { some: {} } },
      select: { id: true },
    });

    const followerIds = followers.map((follower) => follower.id);
    const followerData = await fetchUserData(followerIds);

    const taggedPosts = await prisma.post.findMany({
      where: { text: { contains: "@" } },
      include: { author: true },
    });

    const authorIds = taggedPosts.map((post) => post.author.id);
    const authorData = await fetchUserData(authorIds);

    const activities = [
      ...followers.map((follower) => {
        const user = followerData.find((user) => user.id === follower.id);
        return user
          ? {
              title: "New Follower",
              description: `${user.name} started following you.`,
              avatar: user.avatar,
            }
          : null;
      }),
      ...taggedPosts.map((post) => {
        const author = authorData.find(
          (author) => author.id === post.author.id,
        );
        return {
          title: "Tagged in a Post",
          description: `${author?.name} tagged you in a post.`,
          avatar: author?.avatar,
        };
      }),
    ];

    const feed = activities.filter((activity) => activity !== null);

    return NextResponse.json(feed, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as { text: string; authorId: string };
  const { text, authorId } = body;

  if (!text || !authorId) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  try {
    const newPost = await prisma.post.create({
      data: {
        text,
        author_id: authorId,
      },
    });

    return NextResponse.json(newPost, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
