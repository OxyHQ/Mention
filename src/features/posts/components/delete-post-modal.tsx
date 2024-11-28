import { ConfirmationModal } from "@/components/elements/modal";
import { useLocale } from "@/app/LocaleContext";

import { deleteMedia } from "../api/delete-media";
import { useDeletePost } from "../hooks/use-delete-post";
import { IPost } from "../types";

export const DeletePostModal = ({
  post,
  setIsDeleteModalOpen,
  setIsMenuOpen,
}: {
  post: IPost;
  setIsDeleteModalOpen: (value: boolean) => void;
  setIsMenuOpen: (value: boolean) => void;
}) => {
  const { t } = useLocale();
  const mutation = useDeletePost();

  return (
    <ConfirmationModal
      heading={t("modals.deletePost.heading")}
      paragraph={t("modals.deletePost.paragraph")}
      confirmButtonText={t("modals.deletePost.confirmButtonText")}
      confirmButtonClick={() => {
        mutation.mutate({
          postId: post?.id,
        });
        setIsDeleteModalOpen(false);
        if (post?.media?.length)
          deleteMedia(post?.media?.map((m) => m.media_path));
      }}
      confirmButtonStyle="delete"
      cancelButtonText={t("modals.deletePost.cancelButtonText")}
      cancelButtonClick={() => {
        setIsDeleteModalOpen(false);
        setIsMenuOpen(true);
      }}
    />
  );
};
