"use client";
import { AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useOxySession } from "@oxyhq/services";
import { useState } from "react";

import { DotIcon } from "@/assets/dot-icon";
import { LocationIcon } from "@/assets/location-icon";
import { MessageIcon } from "@/assets/message-icon";
import { ReceiveActivityIcon } from "@/assets/activity-icon";
import { EllipsisWrapper } from "@/components/elements/ellipsis-wrapper";
import { FollowButton } from "@/components/elements/follow-button";
import { Modal } from "@/components/elements/modal";

import { WebsiteIcon } from "../assets/website-icon";
import { IUser } from "../types";
import { following } from "../utils/following";

import { EditProfileModal } from "./edit-profile-modal";
import { InspectImageModal } from "./inspect-image-modal";
import styles from "./styles/user-info.module.scss";
import { UserJoinDate } from "./user-join-date";

export const ProfileInfo = ({ user }: { user: IUser; id: string }) => {
  const { session } = useOxySession();

  const [isEditProfileModalOpen, setIsEditProfileModalOpen] = useState(false);

  const [inspectModal, setInspectModal] = useState({
    isOpen: false,
    source: "",
    sourceType: "",
  });

  const isFollowing = following({
    user: user,
    session_owner_id: session?.user?.id as string,
  });

  const shouldHideFollowers = user?.privacySettings?.hideFollowers;
  const shouldHidePosts = user?.privacySettings?.hidePosts;

  return (
    <div className={styles.container}>
      <div className={styles.banner}>
        {user?.profile_banner_url && (
          <button
            className={styles.bannerButton}
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => {
              setInspectModal({
                isOpen: true,
                source: user?.profile_banner_url || "",
                sourceType: "banner",
              });
            }}
          >
            <Image
              src={user?.profile_banner_url}
              alt="banner"
              fill={true}
              draggable={true}
            />
          </button>
        )}
      </div>
      <div className={styles.info}>
        <div className={styles.avatar}>
          <button
            className={styles.avatarButton}
            aria-label="Inspect profile picture"
            onClick={() => {
              setInspectModal({
                isOpen: true,
                source: user?.avatar || "",
                sourceType: "avatar",
              });
            }}
          >
            <Image
              src={user?.avatar || "/user_placeholder.png"}
              alt="avatar"
              draggable={true}
              fill={true}
            />
          </button>
        </div>

        <div className={styles.editProfile}>
          {session?.user?.id === user?.id ? (
            <button
              aria-expanded="false"
              aria-haspopup="menu"
              aria-label="Edit profile"
              onClick={() => setIsEditProfileModalOpen(true)}
              className={styles.editProfileButton}
            >
              Edit Profile
            </button>
          ) : (
            <div className={styles.visitorActions}>
              {session && (
                <button
                  aria-expanded="false"
                  aria-haspopup="menu"
                  aria-label="More"
                  data-title="More"
                  className={styles.options}
                >
                  <DotIcon />
                </button>
              )}
              {session && (
                <button
                  aria-label="Message"
                  data-title="Message"
                  className={styles.message}
                >
                  <MessageIcon />
                </button>
              )}
              {session && (
                <button
                  aria-label="Turn on Post activity"
                  data-title="Notify"
                  className={styles.activity}
                >
                  <ReceiveActivityIcon />
                </button>
              )}

              <FollowButton
                user_id={user?.id}
                session_owner_id={session?.user?.id as string}
                isFollowing={isFollowing}
                username={user?.username}
              />
            </div>
          )}
        </div>

        <div className={styles.user}>
          <div className={styles.name}>
            <EllipsisWrapper>
              <h2>{user?.name}</h2>
            </EllipsisWrapper>

            <EllipsisWrapper>
              <span>@{user?.username}</span>
            </EllipsisWrapper>
          </div>

          {user?.description && (
            <div className={styles.bio}>
              <p>{user?.description}</p>
            </div>
          )}

          <div className={styles.locationAndJoined}>
            {user?.location && (
              <div className={styles.location} role="presentation">
                <LocationIcon />
                <span className={styles.text}>{user?.location}</span>
              </div>
            )}

            {user?.url && (
              <div className={styles.website}>
                <WebsiteIcon />
                <a
                  className={styles.text}
                  href={user?.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {user?.url}
                </a>
              </div>
            )}

            {user?.created_at && <UserJoinDate date={user?.created_at} />}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isEditProfileModalOpen && (
          <Modal
            onClose={() => {
              setIsEditProfileModalOpen(false);
            }}
            disableScroll={true}
            background="var(--clr-modal-background)"
          >
            <EditProfileModal
              user={user}
              closeModal={() => setIsEditProfileModalOpen(false)}
            />
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {inspectModal.isOpen && (
          <Modal
            onClose={() => {
              setInspectModal({
                isOpen: false,
                source: "",
                sourceType: "",
              });
            }}
            disableScroll={true}
            background="var(--clr-modal-background)"
          >
            <InspectImageModal
              source={inspectModal.source}
              sourceType={inspectModal.sourceType}
              closeModal={() => {
                setInspectModal({
                  isOpen: false,
                  source: "",
                  sourceType: "",
                });
              }}
            />
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
};
