import type React from 'react';
import { useMemo } from 'react';
import { InlineMarkdown } from '@oxy.so/bloom/markdown';
import { truncateInlineMarkdown } from '@oxy.so/bloom/markdown/inline';
import { parsePostInlineMarkdown, postMentionForLink } from '@/utils/postInlineMarkdown';
import { openExternalLink } from '@/utils/openExternalLink';
import { Text } from 'react-native';
import { LinkifiedText, MentionTextLink } from '../common/LinkifiedText';
import { useRouter } from '@/lib/navigation/router';
import type { PostContent } from '@mention/shared-types';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { readerKeys, toggleReaderFlag, useReaderFlag } from '@/stores/readerStateStore';
import { type PostLinkCard, withoutCardLinks } from '@/utils/postLinkCards';
import { useTranslation } from 'react-i18next';

interface Props {
  content?: string | PostContent;
  postId?: string;
  previewChars?: number;
  /** Larger reading text for the focused post. */
  detail?: boolean;
  /** Small inline context after the body, such as a position in an author thread. */
  trailingContent?: React.ReactNode;
  /**
   * A body the READER chose over the one the server resolved — another author
   * rendition of this post, or a machine translation of it. `null` (the norm)
   * renders `content.text`, which hydration has already localized for this
   * viewer. This component never picks a language itself.
   */
  overrideText?: string | null;
  /**
   * The link cards the post renders (`postLinkCards`). A bare link one of them
   * shows is dropped from the body when it stands on its own line or ends the
   * text — repeating it next to its card is noise.
   */
  linkCards?: readonly PostLinkCard[];
}

/** In-feed truncation thresholds (chars) per the `postTextExpand` preference. */
const PREVIEW_CHARS = { default: 280, more: 600, muchMore: 1200, all: Infinity } as const;

const PostContentText: React.FC<Props> = ({
  content,
  postId,
  previewChars,
  detail = false,
  trailingContent,
  overrideText,
  linkCards,
}) => {
  const router = useRouter();
  // Keep navigation scoped to the containing panel. The translated suffix
  // remains in its own component so full rows need no translation subscription.
  const postTextExpand =
    useAppearanceStore((s) => s.mySettings?.appearance?.postTextExpand) ?? 'default';
  const postReadMoreAction =
    useAppearanceStore((s) => s.mySettings?.appearance?.postReadMoreAction) ?? 'openPost';
  const effectivePreviewChars = previewChars ?? PREVIEW_CHARS[postTextExpand];
  const resolvedText = typeof content === 'string' ? content : content?.text || '';
  const rawText = overrideText || resolvedText;

  const textContent = linkCards ? withoutCardLinks(rawText, linkCards) : rawText;

  const parsed = useMemo(() => parsePostInlineMarkdown(textContent), [textContent]);
  const preview = useMemo(
    () => truncateInlineMarkdown(parsed.nodes, effectivePreviewChars),
    [parsed.nodes, effectivePreviewChars],
  );
  const expandInline = postReadMoreAction === 'expandInline';
  // Held by the POST (`readerStateStore`), not the row: rows are recycled or
  // unmounted on scroll, and a row-held expansion folded shut again. Only the
  // inline-expand setting shows a body expanded; turning it off folds every
  // post back without forgetting which ones the reader opened.
  const expansionKey = readerKeys.postText(postId);
  const isExpanded = useReaderFlag(expansionKey) && expandInline;
  const isTruncated = preview.isTruncated;

  if (!textContent && !trailingContent) return null;

  const suffix =
    isTruncated && postId ? (
      expandInline ? (
        <Text className="text-primary" onPress={() => toggleReaderFlag(expansionKey)}>
          {isExpanded ? <ShowLessLabel /> : ' Read more'}
        </Text>
      ) : (
        <Text className="text-primary" onPress={() => router.push(`/p/${postId}`)}>
          {' Read more'}
        </Text>
      )
    ) : null;

  return (
    <Text
      className={
        detail
          ? 'text-foreground text-[17px] leading-[22px]'
          : 'text-foreground text-[15px] leading-5'
      }
    >
      <InlineMarkdown
        nodes={isExpanded ? parsed.nodes : preview.nodes}
        onLinkPress={openExternalLink}
        renderText={(text) => <LinkifiedText inline text={text} />}
        renderLink={({ url, label, children }) => {
          const mention = postMentionForLink(parsed.mentions, url, label);
          return mention ? (
            <MentionTextLink
              destination={mention.value}
              label={children}
              unverified={mention.unverified}
            />
          ) : undefined;
        }}
        suffix={
          <>
            {suffix}
            {trailingContent}
          </>
        }
      />
    </Text>
  );
};

function ShowLessLabel() {
  const { t } = useTranslation();
  return ` ${t('common.showLess', 'Show less')}`;
}

export default PostContentText;
