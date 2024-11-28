"use client";
import { AnimatePresence } from "framer-motion";
import { useRef, useState } from "react";

import AutoAwesomeTwoToneIcon from "@mui/icons-material/AutoAwesomeTwoTone";
import { Menu, MenuItem } from "@/components/elements/menu";
import { Modal } from "@/components/elements/modal";
import { FeedManagementModal } from "@/components/elements/feed-management-modal";

import { Button } from "../button";
import { Tooltip } from "../tooltip";

export const FeedSelector = () => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isFeedManagementOpen, setIsFeedManagementOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative">
      <Tooltip text="Select Feed">
        <Button
          ref={buttonRef}
          aria-expanded={isModalOpen}
          aria-haspopup="menu"
          aria-label="Select Feed"
          onClick={() => setIsModalOpen(true)}
          className="hover:bg-neutral-500 focus-visible:bg-neutral-500 focus-visible:outline-secondary-100 active:bg-neutral-600"
        >
          <AutoAwesomeTwoToneIcon />
        </Button>
      </Tooltip>

      <AnimatePresence>
        {isModalOpen && (
          <Modal onClose={() => setIsModalOpen(false)} background="none">
            <Menu onClose={() => setIsModalOpen(false)} ref={buttonRef}>
              <MenuItem onClick={() => setIsModalOpen(false)}>For you</MenuItem>
              <MenuItem onClick={() => setIsModalOpen(false)}>
                Following
              </MenuItem>
              <MenuItem onClick={() => setIsFeedManagementOpen(true)}>
                Manage Feeds
              </MenuItem>
            </Menu>
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isFeedManagementOpen && (
          <FeedManagementModal onClose={() => setIsFeedManagementOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
};
