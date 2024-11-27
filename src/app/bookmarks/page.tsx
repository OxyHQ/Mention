import { Bookmarks } from "@/features/bookmarks";
import { LoadingSpinner } from "@/components/elements/loading-spinner";
import { TryAgain } from "@/components/elements/try-again";
import { useOxySession } from "@oxyhq/services";
import { usePosts } from "@/features/posts";

const BookmarksPage = () => {
  const { session } = useOxySession();

  const {
    data: bookmarks,
    isLoading,
    isError,
    isSuccess,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
  } = usePosts({
    queryKey: ["bookmarks", session?.user?.id as string],
    type: "bookmarks",
    id: session?.user?.id,
  });

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (isError) {
    return <TryAgain />;
  }

  return <Bookmarks />;
};

export default BookmarksPage;

export const metadata = {
  title: "Bookmarks",
};
