"use client";
import { usePathname } from "next/navigation";

import { LoadingSpinner } from "@/components/elements/loading-spinner";
import { TryAgain } from "@/components/elements/try-again";
import { IUser, ProfileInfo, ProfileStats, useUser } from "@/features/profile";

export const Profile = ({ initialUser }: { initialUser: IUser }) => {
  const pathname = usePathname();
  const id = initialUser.id;
  const {
    data: user,
    isError,
    status,
  } = useUser({
    id,
    initialData: initialUser,
  });

  if (status === "pending") {
    return <LoadingSpinner />;
  }

  if (status === "error" || isError) {
    return <TryAgain />;
  }

  const shouldHideFollowers = user?.privacySettings?.hideFollowers;
  const shouldHidePosts = user?.privacySettings?.hidePosts;

  return (
    <>
      <ProfileInfo user={user} id={id} />
      <ProfileStats user={user} pathname={pathname} />
      {!shouldHideFollowers && !shouldHidePosts && (
        <>
          {/* 
          <ProfileNavigation id={id} pathname={pathname} />
          */}
        </>
      )}
    </>
  );
};
