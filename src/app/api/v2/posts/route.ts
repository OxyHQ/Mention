import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

const postsStructure = {
  feed: [
    {
      post: {
        uri: "",
        cid: "",
        author: {
          did: "",
          handle: "",
          displayName: "",
          avatar: "",
          associated: {
            chat: {
              allowIncoming: ""
            }
          },
          labels: [],
          createdAt: ""
        },
        record: {
          $type: "",
          createdAt: "",
          embed: {},
          langs: [],
          text: ""
        },
        embed: {},
        replyCount: 0,
        repostCount: 0,
        likeCount: 0,
        quoteCount: 0,
        indexedAt: "",
        labels: []
      },
      feedContext: ""
    }
  ],
  cursor: ""
};

export async function GET(request: Request) {
  const { db } = await connectToDatabase();
  const posts = await db.collection("posts").find({}).toArray();
  return NextResponse.json(posts, { status: 200 });
}

export async function POST(request: Request) {
  const { db } = await connectToDatabase();
  const post = await request.json();
  const result = await db.collection("posts").insertOne(post);
  return NextResponse.json(result.ops[0], { status: 201 });
}

export async function DELETE(request: Request) {
  const { db } = await connectToDatabase();
  const { id } = await request.json();
  const result = await db.collection("posts").deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ deleted: result.deletedCount }, { status: 200 });
}
