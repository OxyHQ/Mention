import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { useOxySession } from "@oxyhq/services";

export async function GET(request: Request) {
  try {
    const session = await useOxySession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const followers = await prisma.profile.findMany({
      where: {
        followers: {
          some: {},
        },
      },
      include: {
        followers: {
          select: {
            avatar: true,
          },
        },
      },
    });

    const taggedPosts = await prisma.post.findMany({
      where: {
        text: {
          contains: "@",
        },
      },
      include: {
        author: true,
      },
    });

    const activities = [
      ...followers.map((follower) => ({
        title: "New Follower",
        description: `${follower.name} started following you.`,
        avatar: follower.avatar,
      })),
      ...taggedPosts.map((post) => ({
        title: "Tagged in a Post",
        description: `${post.author.name} tagged you in a post.`,
        avatar: post.author.avatar,
      })),
    ];

    return NextResponse.json(activities, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
