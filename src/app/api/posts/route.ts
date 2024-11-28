import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type") || undefined;
  const id = searchParams.get("id") || undefined;
  const language = searchParams.get("language") || undefined;

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
    let followingUserIds: string[] = [];
    if (id) {
      followingUserIds = await prisma.profile
        .findUnique({
          where: { id: id },
          select: { following: { select: { id: true } } },
        })
        .then(
          (user) =>
            user?.following.map((followingUser) => followingUser.id) || [],
        );
    }
    if (id) {
      followingUserIds.push(id);
    }

    const posts = await prisma.post.findMany({
      skip,
      take,
      cursor,

      where: {
        ...(type === "comments" && {
          in_reply_to_status_id: id,
        }),

        ...(type === "bookmarks" && {
          bookmarks: {
            some: {
              user_id: id,
            },
          },
        }),

        ...(type === "search" && {
          text: {
            contains: id,
            mode: "insensitive",
          },
        }),

        ...(type === "user_posts" && {
          author_id: id,
        }),

        ...(type === "user_replies" && {
          author_id: id,
          NOT: {
            in_reply_to_status_id: null,
            in_reply_to_username: null,
            in_reply_to_user_id: null,
          },
        }),

        ...(type === "user_media" && {
          author_id: id,
          media: {
            some: {},
          },
        }),

        ...(type === "user_likes" && {
          likes: {
            some: {
              user_id: id,
            },
          },
        }),

        ...(type === "default" && {
          author_id: {
            in: followingUserIds,
          },
        }),
      },

      include: {
        author: {
          include: {
            bookmarks: true,
          },
        },

        likes: true,
        media: true,
        reposts: true,

        quoted_post: {
          include: {
            author: true,
            media: true,
          },
        },

        quotes: true,
        comments: true,

        bookmarks: {
          include: {
            user: true,
          },
          orderBy: {
            created_at: "desc",
          },
        },

        translations: {
          where: {
            language: language,
          },
        },

        _count: {
          select: {
            comments: true,
            likes: true,
            quotes: true,
            reposts: true,
          },
        },
      },

      orderBy: {
        created_at: "desc",
      },
    });

    const authorIds = posts.map((post) => post.author.id);
    const authorData: AuthorData[] = await fetch(
      process.env.NEXT_PUBLIC_OXY_SERVICES_URL +
        `/api/users?ids=${authorIds.join(",")}`,
    )
      .then((response) => response.json() as Promise<AuthorData[]>)
      .catch((error) => {
        console.error("Error:", error);
        return [];
      });

    const postsWithAuthorData = posts.map((post) => {
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
  const { post, translation } = (await request.json()) as {
    post: {
      text: string;
      author_id: string;
      in_reply_to_username?: string;
      in_reply_to_status_id?: string;
      quoted_post_id?: string;
    };
    translation?: {
      language: string;
      translatedText: string;
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

  const translationSchema = z
    .object({
      language: z.string(),
      translatedText: z.string(),
    })
    .strict()
    .optional();

  const zodPost = postSchema.safeParse(post);
  const zodTranslation = translationSchema.safeParse(translation);

  if (!zodPost.success) {
    return NextResponse.json(
      {
        message: "Invalid request body",
        error: zodPost.error.formErrors,
      },
      { status: 400 },
    );
  }

  if (translation && !zodTranslation.success) {
    return NextResponse.json(
      {
        message: "Invalid translation body",
        error: zodTranslation.error.formErrors,
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

    if (translation) {
      await prisma.translation.create({
        data: {
          postId: created_post.id,
          language: translation.language,
          translatedText: translation.translatedText,
        },
      });
    }

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

export async function PUT(request: Request) {
  const { translation } = (await request.json()) as {
    translation: {
      postId: string;
      language: string;
      translatedText: string;
    };
  };

  const translationSchema = z
    .object({
      postId: z.string().cuid(),
      language: z.string(),
      translatedText: z.string(),
    })
    .strict();

  const zodTranslation = translationSchema.safeParse(translation);

  if (!zodTranslation.success) {
    return NextResponse.json(
      {
        message: "Invalid translation body",
        error: zodTranslation.error.formErrors,
      },
      { status: 400 },
    );
  }

  try {
    const existingTranslation = await prisma.translation.findFirst({
      where: {
        postId: translation.postId,
        language: translation.language,
      },
    });

    if (existingTranslation) {
      await prisma.translation.update({
        where: {
          id: existingTranslation.id,
        },
        data: {
          translatedText: translation.translatedText,
        },
      });
    } else {
      await prisma.translation.create({
        data: {
          postId: translation.postId,
          language: translation.language,
          translatedText: translation.translatedText,
        },
      });
    }

    return NextResponse.json(
      {
        message: "Translation updated successfully",
      },
      { status: 200 },
    );
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
