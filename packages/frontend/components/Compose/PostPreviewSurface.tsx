import React from 'react';
import { View, ScrollView } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTranslation } from 'react-i18next';
import type { HydratedPost } from '@mention/shared-types';
import PostItem from '@/components/Feed/PostItem';

export interface PostPreviewSurfaceProps {
  post: HydratedPost;
  title: string;
  /** One line under the title — the publish time, a thread count, a warning. */
  subtitle?: React.ReactNode;
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

  return (
    <View className="flex-1">
      <PageHeader
        title={title}
        subtitle={subtitle}
        onBack={onBack}
        backLabel={t('common.back', { defaultValue: 'Back' })}
        safeArea={false}
      />

      {notice}

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/*
          Inert on purpose — see the component doc. The wrapper carries no
          styling of its own so the post renders at exactly its feed width.
        */}
        <View pointerEvents="none">
          <PostItem post={post} />
        </View>
      </ScrollView>

      {children}
    </View>
  );
};

export default PostPreviewSurface;
