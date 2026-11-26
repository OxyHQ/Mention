import { Card, RawText, type ViewModifier, defineModifier, view } from '@oxy.so/bloom-language';

/** The card's own frame: 200pt wide, at least 140 tall, padded. */
const articleFrame = defineModifier((v) =>
  v.padding('lg').frame({ width: '200', minHeight: '140' }),
);

interface PostArticlePreviewProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  /** The caller's frame and padding in place of the card's own (200pt wide, at least 140 tall). */
  look?: ViewModifier;
}

/**
 * Bloom's outlined card owns the chrome (card fill, 1px border, corner); a card
 * with no `onPress` renders as a plain view, as the disabled touchable did.
 */
const PostArticlePreview = view(function PostArticlePreview({
  title,
  body,
  onPress,
  look,
}: PostArticlePreviewProps) {
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return Card(
    RawText(trimmedTitle || 'Untitled article')
      .foreground('foreground')
      .font('18')
      .leading('28px')
      .weight('bold')
      .margin('bottom', 'md')
      .lines(2),
    trimmedBody
      ? RawText(trimmedBody).foreground('muted').font('sm').leading('18px').lines(3)
      : null,
  )
    .style('outline')
    .radius('lg')
    .modifier(look ?? articleFrame)
    .justify('between')
    .onPress(onPress);
});

export default PostArticlePreview;
