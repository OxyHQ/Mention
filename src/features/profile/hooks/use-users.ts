import { useQuery } from "@tanstack/react-query";
import { useOxySession } from "@oxyhq/services";

import { getUsers } from "../api/get-users";
import { IUser } from "../types";

export const useUsers = ({
  queryKey,
  limit,
}: {
  queryKey: string[];
  limit?: number;
}) => {
  const { session, status } = useOxySession();

  return useQuery<IUser[]>({
    queryKey: [...queryKey, status, session?.user?.id, limit],
    queryFn: async () => {
      if (status === "loading") {
        return [];
      }
      return getUsers({ id: session?.user?.id, limit });
    },
    enabled: status !== "loading",
  });
};
