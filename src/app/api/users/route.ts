import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

interface User {
  id: string;
  name: string;
  username: string;
  email: string;
  [key: string]: any; // for any other properties that might be present
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") || undefined;
  const limit = searchParams.get("limit") || undefined;
  const idSchema = z.string().cuid().optional();
  const limitSchema = z.string().regex(/^\d+$/).optional();

  const zodId = idSchema.safeParse(id);
  const zodLimit = limitSchema.safeParse(limit);

  if (!zodId.success) {
    return NextResponse.json(zodId.error, { status: 400 });
  }

  if (!zodLimit.success) {
    return NextResponse.json(zodLimit.error, { status: 400 });
  }

  try {
    // Fetch additional data for each user
    const response = await fetch(
      process.env.NEXT_PUBLIC_OXY_SERVICES_URL +
        `/api/users${id ? `?id=${id}` : ""}${limit ? `&limit=${limit}` : ""}`,
    );

    if (!response.ok) {
      return NextResponse.json({ error: "Failed to fetch data from external API" }, { status: response.status });
    }

    const data = await response.text();
    if (!data) {
      return NextResponse.json({ error: "Data is undefined or null" }, { status: 404 });
    }

    const parsedData: User[] = JSON.parse(data) as User[];

    if (parsedData.length === 0) {
      return NextResponse.json({ error: "No data found" }, { status: 404 });
    }

    const usersWithAdditionalData = await prisma.profile.findMany({
      where: {
        id: {
          in: parsedData.map((user) => user.id),
        },
      },
      select: {
        id: true,
        following: true,
        followers: true,
      },
      take: limit ? parseInt(limit) : undefined,
    });

    const mergedData = parsedData.map((user) => {
      const additionalData = usersWithAdditionalData.find(
        (userData) => userData.id === user.id,
      );
      return {
        ...user,
        ...additionalData,
      };
    });

    return NextResponse.json(mergedData, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
