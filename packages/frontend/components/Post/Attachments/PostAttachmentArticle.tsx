import { RawText, VStack, type ViewModifier, defineModifier, view } from '@oxy.so/bloom-language';

/** The card's own frame: 200pt wide, at least 140 tall. */
const articleFrame = defineModifier((v) => v.frame({ width: '200', minHeight: '140' }));

interface PostAttachmentArticleProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  /**
   * The card's frame from the row (its full width alone, its cell's width and the
   * row's height beside others), always with the card's 140pt floor; 200pt wide
   * by default.
   */
  look?: ViewModifier;
}

// A touchable card: its press dims it (`activeOpacity` 0.85).
const PostAttachmentArticle = view(function PostAttachmentArticle({
  title,
  body,
  onPress,
  look = articleFrame,
}: PostAttachmentArticleProps) {
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return VStack(
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
    .justify('between')
    .padding('lg')
    .modifier(look)
    .background('card')
    .border('border', 'thin')
    .corner('14')
    .onPress(onPress)
    .disabled(!onPress)
    .pressFade('85');
});

export default PostAttachmentArticle;
