import { getUserMetadata } from "@/features/profile/api/get-user-metadata";
import { getUserLikes } from "@/features/profile/api/get-user-likes";
import { Profile } from "@/features/profile";

export default async function LikesPage({
  params,
}: {
  params: { user: string };
}) {
  const user = await getUserMetadata({
    user_id: params.user,
    type: "likes",
  });

  const likes = await getUserLikes(params.user);

  return (
    <div>
      <Profile initialUser={user} />
      <div>
        {likes.map((like: any) => (
          <div key={like.id}>{like.text}</div>
        ))}
      </div>
    </div>
  );
}
