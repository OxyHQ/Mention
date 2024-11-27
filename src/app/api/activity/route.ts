import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { useOxySession } from "@oxyhq/services";

export async function GET() {
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
      select: {
        id: true,
      },
    });

    const followerIds = followers.map((follower) => follower.id);
    const followerData: { id: string; name: string; avatar: string }[] =
      await fetch(
        process.env.NEXT_PUBLIC_OXY_SERVICES_URL +
          `/api/users?ids=${followerIds.join(",")}`,
      ).then(async (response) => {
        const data = await response.json();
        return data as { id: string; name: string; avatar: string }[];
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

    const authorIds = taggedPosts.map((post) => post.author.id);
    const authorData: { id: string; name: string; avatar: string }[] =
      await fetch(
        process.env.NEXT_PUBLIC_OXY_SERVICES_URL +
          `/api/users?ids=${authorIds.join(",")}`,
      ).then(async (response) => {
        const data = await response.json();
        return data as { id: string; name: string; avatar: string }[];
      });

    const activities = [
      ...followers.map((follower) => {
        const user = followerData.find((user) => user.id === follower.id);
        if (user) {
          return {
            title: "New Follower",
            description: `${user.name} started following you.`,
            avatar: user.avatar,
          };
        }
        return null;
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

    return NextResponse.json(activities, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
