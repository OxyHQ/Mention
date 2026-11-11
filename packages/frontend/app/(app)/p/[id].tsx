import { useEffect } from 'react';
import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { useOptionalPanelRouter } from '@oxy.so/bloom/panel-routing';
import { useLocalSearchParams } from '@/lib/navigation/router';
import PostDetailScreen from '@/components/Post/PostDetailScreen';
import { usePostPaneStore } from '@/components/Post/postPane';

export default function PostRoute() {
  const panel = useOptionalPanelRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const hostId = useAppShellPanel().id;
  const closePane = usePostPaneStore((state) => state.close);
  // The panel under this one shows people of THIS post: it goes when the post does.
  useEffect(
    () => () => {
      if (hostId) closePane(hostId);
    },
    [hostId, id, closePane],
  );
  return <PostDetailScreen postId={id ?? ''} onBack={panel?.back} />;
}
