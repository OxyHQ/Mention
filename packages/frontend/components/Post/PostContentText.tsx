import type React from 'react';
import { useMemo } from 'react';
import { InlineMarkdown } from '@oxy.so/bloom/markdown';
import { truncateInlineMarkdown } from '@oxy.so/bloom/markdown/inline';
import { parsePostInlineMarkdown, postMentionForLink } from '@/utils/postInlineMarkdown';
import { openExternalLink } from '@/utils/openExternalLink';
import { LinkifiedText, MentionTextLink, PrimaryText } from '../common/LinkifiedText';
import { useRouter } from '@/lib/navigation/router';
import type { PostContent } from '@mention/shared-types';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { usePostTextExpansion } from '@/hooks/useExpandableText';
import { type PostLinkCard, withoutCardLinks } from '@/utils/postLinkCards';
import { useTranslation } from 'react-i18next';

import { Embed, RawText, toElement } from '@oxy.so/bloom-language';

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
  const expansion = usePostTextExpansion(postId);
  // Only the inline-expand setting shows a body expanded; turning it off folds
  // every post back without forgetting which ones the reader opened.
  const isExpanded = expandInline && expansion.isExpanded;
  const isTruncated = preview.isTruncated;

  if (!textContent && !trailingContent) return null;

  const suffix =
    isTruncated && postId ? (
      expandInline ? (
        <PrimaryText onPress={expansion.toggle}>
          {isExpanded ? <ShowLessLabel /> : READ_MORE}
        </PrimaryText>
      ) : (
        <PrimaryText onPress={() => router.push(`/p/${postId}`)}>{READ_MORE}</PrimaryText>
      )
    ) : null;

  // The body's text: the markdown's runs (links and mentions among them) as
  // spans of one React Native text, in the larger reading size on a detail page.
  return toElement(
    RawText(
      Embed(
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
        />,
      ),
    )
      .foreground('foreground')
      .font(detail ? 'lg' : 'md')
      .leading(detail ? '22px' : '20px'),
  );
};

/** The truncated body's continuation link, after its last word. */
const READ_MORE = ' Read more';

function ShowLessLabel() {
  const { t } = useTranslation();
  return ` ${t('common.showLess', 'Show less')}`;
}

export default PostContentText;
