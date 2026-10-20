import type React from 'react';
import { useMemo } from 'react';
import { InlineMarkdown } from '@oxy.so/bloom/markdown';
import { truncateInlineMarkdown } from '@oxy.so/bloom/markdown/inline';
import { parsePostInlineMarkdown, postMentionForLink } from '@/utils/postInlineMarkdown';
import { openExternalLink } from '@/utils/openExternalLink';
import { StyleSheet, Text } from 'react-native';
import { LinkifiedText, MentionTextLink } from '../common/LinkifiedText';
import { useRouter } from '@/lib/navigation/router';
import type { PostContent } from '@mention/shared-types';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { useTextExpansion } from '@/hooks/useExpandableText';
import { useTranslation } from 'react-i18next';

interface Props {
  content?: string | PostContent;
  postId?: string;
  previewChars?: number;
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
   * URLs the post renders as preview cards. A trailing URL in the body is
   * trimmed when it matches ANY of them — the card already shows the link, so
   * repeating it as the last line of the text is noise.
   */
  linkPreviewUrls?: string[];
}

const TRAILING_URL_RE = /\s*(https?:\/\/[^\s]+|www\.[^\s]+)\s*$/;

/** In-feed truncation thresholds (chars) per the `postTextExpand` preference. */
const PREVIEW_CHARS = { default: 280, more: 600, muchMore: 1200, all: Infinity } as const;

const PostContentText: React.FC<Props> = ({
  content,
  postId,
  previewChars,
  trailingContent,
  overrideText,
  linkPreviewUrls,
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

  const textContent =
    linkPreviewUrls && linkPreviewUrls.length > 0
      ? rawText.replace(TRAILING_URL_RE, (match: string, url: string) =>
          linkPreviewUrls.includes(url) ? '' : match,
        )
      : rawText;

  const parsed = useMemo(() => parsePostInlineMarkdown(textContent), [textContent]);
  const preview = useMemo(
    () => truncateInlineMarkdown(parsed.nodes, effectivePreviewChars),
    [parsed.nodes, effectivePreviewChars],
  );
  const { isExpanded, toggle } = useTextExpansion(textContent, postReadMoreAction);
  const isTruncated = preview.isTruncated;

  if (!textContent && !trailingContent) return null;

  const suffix =
    isTruncated && postId ? (
      postReadMoreAction === 'expandInline' ? (
        <Text className="text-primary" onPress={toggle}>
          {isExpanded ? <ShowLessLabel /> : ' Read more'}
        </Text>
      ) : (
        <Text className="text-primary" onPress={() => router.push(`/p/${postId}`)}>
          {' Read more'}
        </Text>
      )
    ) : null;

  return (
    <Text style={styles.postText} className="text-foreground">
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
  return <>{` ${t('common.showLess', 'Show less')}`}</>;
}

export default PostContentText;

const styles = StyleSheet.create({
  postText: {
    fontSize: 15,
    lineHeight: 20,
  },
});
