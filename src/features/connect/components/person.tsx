import { useRouter } from "next/navigation";
import { useOxySession } from "@oxyhq/services";

import { EllipsisWrapper } from "@/components/elements/ellipsis-wrapper";
import { FollowButton } from "@/components/elements/follow-button";
import {
  Avatar,
  following,
  IUser,
  LinkToProfile,
  UserModalWrapper,
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
          <UserModalWrapper userId={person?.id} delay={500}>
            <Avatar userImage={person?.avatar} />
          </UserModalWrapper>
        </div>

        <div className={styles.info}>
          <UserModalWrapper userId={person?.id} delay={500}>
            <LinkToProfile username={person?.username}>
              <EllipsisWrapper>
                <UserName
                  name={person?.name}
                  isVerified={person?.verified}
                  hover={true}
                />
              </EllipsisWrapper>
            </LinkToProfile>
          </UserModalWrapper>

          <UserModalWrapper userId={person?.id} delay={500}>
            <EllipsisWrapper>
              <UserUsername username={person?.username} />
            </EllipsisWrapper>
          </UserModalWrapper>
        </div>
      </button>

      <div className={styles.follow}>
        <FollowButton
          user_id={person?.id}
          session_owner_id={session?.user?.id as string}
          isFollowing={isFollowing}
          username={person?.username}
        />
      </div>
    </div>
  );
};
