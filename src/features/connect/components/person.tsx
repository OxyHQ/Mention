import { useRouter } from "next/navigation";
import { useOxySession } from "@oxyhq/services";

import { EllipsisWrapper } from "@/components/elements/ellipsis-wrapper";
import { FollowButton } from "@/components/elements/follow-button";
import {
  Avatar,
  following,
  IUser,
  UserName,
  UserUsername,
} from "@/features/profile";

import styles from "./styles/person.module.scss";

export const Person = ({ person }: { person: IUser }) => {
  const { session } = useOxySession();
  const router = useRouter();

  const isFollowing = following({
    user: person,
    session_owner_id: session?.user?.id as string,
  });

  return (
    <div className={styles.container}>
      <button
        className={styles.person}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            router.push(`/${person?.username}`);
          }
        }}
        onClick={() => router.push(`/${person?.username}`)}
      >
        <div className={styles.avatar}>
          <Avatar userImage={person.avatar} />
        </div>
        <div className={styles.details}>
          <UserName name={person.name} />
          <UserUsername username={person.username} />
        </div>
      </button>
      <div className={styles.actions}>
        <FollowButton
          isFollowing={isFollowing}
          user_id={person.id}
          username={person.username}
          session_owner_id={session?.user?.id as string}
        />
      </div>
    </div>
  );
};
