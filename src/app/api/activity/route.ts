import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const followers = await prisma.profile.findMany({
      where: {
        followers: {
          some: {},
        },
      },
      include: {
        followers: true,
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

    const activities = [...followers, ...taggedPosts];
    return NextResponse.json(activities, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
