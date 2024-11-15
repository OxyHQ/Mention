"use client";

import { useCurrentUser } from "@/features/auth";
import { UserInfo } from "@/features/profile";
import { UserRole } from "@prisma/client";

const ClientPage = () => {
  const user = useCurrentUser();

  const extendedUser = user
    ? {
        ...user,
        role: UserRole.USER, // Assuming a default role, adjust as needed
        isTwoFactorEnabled: false, // Assuming default value, adjust as needed
        isOAuth: false, // Assuming default value, adjust as needed
      }
    : undefined;

  return <UserInfo label="📱 Client component" user={extendedUser} />;
};

export default ClientPage;
