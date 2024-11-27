"use client";

import { Button } from "@/components/ui/button";
import { Header, ActivityHeader } from "@/features/header";
import { HamburgerButton } from "@/components/elements/hamburger-button";
import { Avatar } from "@/features/profile";
import { useEffect, useState } from "react";

const fetchAvatarUrls = async () => {
  // Replace this with your actual API call or configuration file fetching logic
  return [
    "https://grtqfohpifovervglcrg.supabase.co/storage/v1/object/public/avatars/414876655_3680318035531765_3288461531498532784_n.jpg",
    "https://grtqfohpifovervglcrg.supabase.co/storage/v1/object/public/avatars/414876655_3680318035531765_3288461531498532784_n.jpg",
    "https://grtqfohpifovervglcrg.supabase.co/storage/v1/object/public/avatars/414876655_3680318035531765_3288461531498532784_n.jpg",
  ];
};

const Activity = () => {
  const [activityArray, setActivityArray] = useState([
    {
      title: "Your call has been confirmed.",
      description: "1 hour ago",
      avatar: "", // Add avatar property
    },
    {
      title: "You have a new message!",
      description: "1 hour ago",
      avatar: "", // Add avatar property
    },
    {
      title: "Your subscription is expiring soon!",
      description: "2 hours ago",
      avatar: "", // Add avatar property
    },
  ]);

  useEffect(() => {
    const fetchAvatars = async () => {
      const avatars = await fetchAvatarUrls();
      setActivityArray((prevArray) =>
        prevArray.map((item, index) => ({
          ...item,
          avatar: avatars[index],
        }))
      );
    };

    fetchAvatars();
  }, []);

  const unreadCount = activityArray.length;

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

export default Activity;

export const metadata = {
  title: "Activity",
};
