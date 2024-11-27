import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Header, ActivityHeader } from "@/features/header";
import { Avatar } from "@/features/profile";

const ActivityPage = () => {
  interface Notification {
    avatar: string;
    title: string;
    description: string;
  }

  const [activityArray, setActivityArray] = useState<Notification[]>([]);
  const unreadCount = activityArray.length;

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch("/api/activity");
        const data = (await response.json()) as Notification[];
        setActivityArray(data);
      } catch (error) {
        console.error("Error fetching activity data:", error);
      }
    };

    fetchData();
  }, []);

  return (
    <div>
      <ActivityHeader />
      <p className="p-4 text-center">You have {unreadCount} unread messages.</p>
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
        <div className="mt-4">
          <Button className="w-full">Mark all as read</Button>
        </div>
      </div>
    </div>
  );
};

export default ActivityPage;

export const metadata = {
  title: "Activity",
  description: "The latest stories on Mention - as told by Posts.",
};
