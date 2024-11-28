"use client";
import { AnimatePresence } from "framer-motion";
import { useRef, useState } from "react";

import ViewDayTwoToneIcon from "@mui/icons-material/ViewDayTwoTone";
import { Menu, MenuItem } from "@/components/elements/menu";
import { Modal } from "@/components/elements/modal";

import { Button } from "../button";
import { Tooltip } from "../tooltip";

export const SortPosts = ({
  onSortChange,
}: {
  onSortChange: (sortOption: string) => void;
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleSortChange = (sortOption: string) => {
    onSortChange(sortOption);
    setIsModalOpen(false);
  };

  return (
    <div className="relative">
      <Tooltip text="Sort Posts">
        <Button
          ref={buttonRef}
          aria-expanded={isModalOpen}
          aria-haspopup="menu"
          aria-label="Sort Posts"
          onClick={() => setIsModalOpen(true)}
          className="hover:bg-neutral-500 focus-visible:bg-neutral-500 focus-visible:outline-secondary-100 active:bg-neutral-600"
        >
          <ViewDayTwoToneIcon />
        </Button>
      </Tooltip>

      <AnimatePresence>
        {isModalOpen && (
          <Modal onClose={() => setIsModalOpen(false)} background="none">
            <Menu onClose={() => setIsModalOpen(false)} ref={buttonRef}>
              <MenuItem onClick={() => handleSortChange("default")}>
                Default
              </MenuItem>
              <MenuItem onClick={() => handleSortChange("date")}>
                By date
              </MenuItem>
              <MenuItem onClick={() => handleSortChange("popularity")}>
                By popularity
              </MenuItem>
            </Menu>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
};
