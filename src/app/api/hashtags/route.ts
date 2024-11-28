import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const hashtags = await prisma.hashtag.findMany({
      take: 10,
      orderBy: {
        score: "desc",
      },
    });
    return NextResponse.json(hashtags, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const { hashtags, postDeleted } = (await request.json()) as { hashtags: string[], postDeleted: boolean };

  const hashtagsSchema = z.array(z.string());

  const zod = hashtagsSchema.safeParse(hashtags);

  if (!zod.success) {
    return NextResponse.json({ error: zod.error }, { status: 400 });
  }

  if (postDeleted) {
    return NextResponse.json(
      {
        message: "Post deleted, no hashtags created",
      },
      { status: 200 },
    );
  }

  try {
    for (const hashtag of hashtags) {
      const hashtagExists = await prisma.hashtag.findUnique({
        where: {
          hashtag: hashtag.toLowerCase(),
        },
      });

      if (hashtagExists) {
        await prisma.hashtag.update({
          where: {
            hashtag: hashtag.toLowerCase(),
          },
          data: {
            score: {
              increment: 1,
            },
          },
        });
      } else {
        await prisma.hashtag.create({
          data: {
            text: hashtag,
            hashtag: hashtag.toLowerCase(),
          },
        });
      }
    }

    return NextResponse.json(
      {
        message: "Hashtag(s) created",
      },
      { status: 200 },
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        error: error.message,
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const { hashtags, postDeleted } = (await request.json()) as { hashtags: string[], postDeleted: boolean };

  const hashtagsSchema = z.array(z.string());

  const zod = hashtagsSchema.safeParse(hashtags);

  if (!zod.success) {
    return NextResponse.json({ error: zod.error }, { status: 400 });
  }

  if (!postDeleted) {
    return NextResponse.json(
      {
        message: "Hashtags not deleted as post is not deleted",
      },
      { status: 200 },
    );
  }

  try {
    for (const hashtag of hashtags) {
      await prisma.hashtag.delete({
        where: {
          hashtag: hashtag.toLowerCase(),
        },
      });
    }

    return NextResponse.json(
      {
        message: "Hashtag(s) deleted",
      },
      { status: 200 },
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        error: error.message,
      },
      { status: 500 },
    );
  }
}
