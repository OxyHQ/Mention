import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  try {
    const { id, name }: { id?: string; name: string } =
      (await request.json()) as { id?: string; name: string };
    let feed;
    if (id) {
      feed = await prisma.feed.update({
        where: { id: Number(id) },
        data: { name },
      });
    } else {
      feed = await prisma.feed.create({
        data: { name },
      });
    }
    return NextResponse.json(feed, { status: 200 });
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    } else {
      return NextResponse.json(
        { error: "Error creating or updating feed" },
        { status: 500 },
      );
    }
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
