import type React from 'react';
import { ScrollView, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { HydratedPost } from '@mention/shared-types';
import { PostItem } from '@/components/Feed/PostItem.bloom';
import { Embed, Header, VStack, toElement, type ViewNode } from '@oxy.so/bloom-language';

/** Tailwind's `flex-1`: the scroll takes the room the header and actions leave. */
const FILL = { flexGrow: 1, flexShrink: 1, flexBasis: '0%' } satisfies ViewStyle;

interface PostPreviewSurfaceProps {
  post: HydratedPost;
  title: string;
  /** One line under the title — the publish time, a thread count, a warning. */
  subtitle?: ViewNode;
  /** Full-width strip between the title and the post (e.g. a past-due notice). */
  notice?: React.ReactNode;
  onBack: () => void;
  /** The actions for this particular preview. */
  children?: React.ReactNode;
}

/**
 * How an unpublished post will look once it goes out.
 *
 * ONE surface for both unpublished things the composer holds — a scheduled post
 * (a server document) and a local draft — because "what will this look like" has
 * exactly one right answer, and two components answering it would drift. What
 * differs between them is the ACTIONS, so those are `children`; the rendering is
 * not negotiable and lives here.
 *
 * It renders through `PostItem` — the SAME component the feed and post detail
 * render — deliberately: a preview built from its own markup would start telling
 * the truth and quietly stop the first time either side changed.
 *
 * The post is INERT (`pointerEvents="none"`). Two reasons, both real: `PostItem`'s
 * tap target opens `/p/<id>`, which for an unpublished post is a 404 by the ACL
 * protecting it (and for a draft is not a URL at all); and liking, boosting or
 * voting on something that has not been published is not a meaningful action.
 * Scrolling still works — the ScrollView is outside the inert subtree.
 */
const PostPreviewSurface: React.FC<PostPreviewSurfaceProps> = ({
  post,
  title,
  subtitle,
  notice,
  onBack,
  children,
}) => {
  const { t } = useTranslation();

  return toElement(
    VStack(
      Header(title)
        .subtitle(subtitle)
        .onBack(onBack)
        .backLabel(t('common.back', { defaultValue: 'Back' }))
        .safeArea(false)
        .inPage(),
      Embed(notice),
      Embed(
        <ScrollView style={FILL} showsVerticalScrollIndicator={false}>
          {/*
      Inert on purpose — see the component doc. The wrapper carries no
      styling of its own so the post renders at exactly its feed width.
    */}
          {toElement(VStack(Embed(toElement(PostItem({ post })))).allowsHitTesting(false))}
        </ScrollView>,
      ),
      Embed(children),
    ).flex('1'),
  );
};

export default PostPreviewSurface;
