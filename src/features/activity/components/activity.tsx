"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/features/profile";
import { useOxySession } from "@oxyhq/services";

export const Activity = () => {
  const { session } = useOxySession();
  const [activityArray, setActivityArray] = useState<
    { avatar: string; title: string; description: string }[]
  >([]);
  const unreadCount = activityArray.length;

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch("/api/activity");
        const data = (await response.json()) as {
          avatar: string;
          title: string;
          description: string;
        }[];
        if (Array.isArray(data)) {
          setActivityArray(
            data.map((item) => ({
              avatar: item.avatar,
              title: item.title,
              description: item.description,
            })),
          );
        } else {
          console.error("Fetched data is not an array:", data);
        }
      } catch (error) {
        console.error("Error fetching activity data:", error);
      }
    };

    fetchData();
  }, [session]);

  return (
    <div>
      <p className="p-4 text-center">
        You have {unreadCount} unread notifications.
      </p>
      <div className="mx-2 w-full border-0 p-1">
        <div className="grid gap-4">
          {activityArray.map((notification, index) => (
            <div
              key={index}
              className="mb-4 grid grid-cols-[calc(var(--tw-fs-kilo)+9px+.5rem)_1fr] items-start pb-4 last:mb-0 last:pb-0"
            >
              <Avatar userImage={notification.avatar} />
              <div className="space-y-1">
                <p className="text-sm font-medium leading-none">
                  {notification.title}
                </p>
                <p className="text-muted-foreground text-sm">
                  {notification.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
