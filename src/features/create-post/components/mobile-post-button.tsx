"use client";
import { usePathname } from "next/navigation";
import { useOxySession } from "@oxyhq/services";

import { Button } from "@/components/elements/button";
import { Tooltip } from "@/components/elements/tooltip";
import { useCreatePostModal } from "@/stores/use-create-post-modal";

import { PenIcon } from "../assets/pen-icon";

export const MobilePostButton = () => {
  const { session } = useOxySession();
  const openModal = useCreatePostModal((state) => state.openModal);
  const pathname = usePathname();
  const path = pathname.split("/")[1];

  if (!session || path === "messages") return null;

  return (
    <Tooltip maxWidth={500} text="Post">
      <Button
        aria-label="Post"
        onClick={() => {
          openModal();
        }}
        className="w-full bg-primary-100 p-[1em] hover:bg-primary-200 focus-visible:outline-secondary-100 active:bg-primary-300"
      >
        <span className="fill-white-100 xxl:hidden [&>svg]:size-h1">
          <PenIcon />
        </span>
      </Button>
    </Tooltip>
  );
};
