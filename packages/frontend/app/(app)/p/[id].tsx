import { useOptionalPanelRouter } from '@oxy.so/bloom/panel-routing';
import { useLocalSearchParams } from '@/lib/navigation/router';
import PostDetailScreen from '@/components/Post/PostDetailScreen';

export default function PostRoute() {
  const panel = useOptionalPanelRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PostDetailScreen postId={id ?? ''} onBack={panel?.back} />;
}
