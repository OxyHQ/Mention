import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { useTranslation } from 'react-i18next';
import { describeContentLanguage } from '@/constants/contentLanguages';
import {
  Button as LButton,
  Card as LCard,
  Embed,
  Group,
  HStack,
  Header,
  Icon,
  Image,
  RawText,
  Text as LText,
  TextEditor,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

/** Matches the backend cap on `content.media[].alt`. */
const ALT_MAX_LENGTH = 2000;

interface AltTextSheetProps {
  /** Resolved, ready-to-render preview URL for the image being described. */
  imageUrl: string;
  /**
   * The languages this image's description can be written in, in tab order.
   * A single entry renders no selector — an image that only exists in one
   * language has nothing to switch between.
   */
  languageTags: readonly string[];
  /** Which language the sheet opens on — the tab the author came from. */
  initialTag: string;
  /** The description currently stored for a language ('' when none). */
  getAlt: (tag: string) => string;
  /** Every description the author edited, by language tag. */
  onSave: (altByTag: Record<string, string>) => void;
  onClose: () => void;
}

/**
 * Bottom-sheet alt-text editor (Bluesky-style).
 *
 * When a post carries several author languages, the SAME image needs a
 * description in each of them: a blind reader in Spanish is served the Spanish
 * body, so they must get the Spanish alt too. The selector here writes into
 * `variant.alt[mediaId]` for the shared image set — which is why the sheet edits
 * every language at once and reports them together on Done.
 *
 * An image that belongs to a language's OWN media set is passed a single tag:
 * its description lives on the image itself, not in a per-language map.
 */
const AltTextSheet: React.FC<AltTextSheetProps> = ({
  imageUrl,
  languageTags,
  initialTag,
  getAlt,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation();

  const tags = useMemo(
    () => (languageTags.includes(initialTag) ? languageTags : [initialTag, ...languageTags]),
    [languageTags, initialTag],
  );

  const [activeTag, setActiveTag] = useState(initialTag);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const tag of tags) initial[tag] = getAlt(tag);
    return initial;
  });

  const value = values[activeTag] ?? '';

  const handleChange = useCallback(
    (next: string) => setValues((prev) => ({ ...prev, [activeTag]: next })),
    [activeTag],
  );

  const handleSave = useCallback(() => {
    const trimmed: Record<string, string> = {};
    for (const [tag, alt] of Object.entries(values)) trimmed[tag] = alt.trim();
    onSave(trimmed);
    onClose();
  }, [values, onSave, onClose]);

  return toElement(
    VStack(
      Header(t('compose.altText.heading', { defaultValue: 'Alt text' }))
        .titleAlign('center')
        .safeArea(false)
        .toolbarLeading(
          LButton(Icon(RiCloseLine))
            .shape('circle')
            .style('subtle')
            .tint('neutral')
            .onPress(onClose)
            .label(t('common.close', { defaultValue: 'Close' })),
        )
        .inPage(),
      Embed(
        <ScrollView
          contentContainerStyle={scrollContentStyle}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {toElement(
            Group(
              RawText(
                t('compose.altText.help', {
                  defaultValue:
                    'Describe this image for people who are blind or have low vision, and to add context for everyone.',
                }),
              )
                .font('sm')
                .foreground('muted')
                .margin('top', 'md')
                .margin('bottom', 'md')
                .padding('horizontal', 'lg')
                .leading('18px'),
              imageUrl
                ? LCard(
                    // Tailwind's `w-full` on the preview, at the picture's own ratio.
                    Image(imageUrl)
                      .frame({ width: 'full' })
                      .aspectRatio(16 / 9)
                      .contentFit('cover'),
                  )
                    .style('outline')
                    .elevation('none')
                    .radius('lg')
                    .margin('horizontal', 'lg')
                    .margin('bottom', 'md')
                : null,
              tags.length > 1
                ? Embed(
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      keyboardShouldPersistTaps="handled"
                      contentContainerStyle={tabsContentStyle}
                    >
                      {tags.map((tag) => {
                        const isActive = tag === activeTag;
                        const hasAlt = (values[tag] ?? '').trim().length > 0;
                        return toElement(
                          HStack(
                            RawText(describeContentLanguage(tag).nativeName)
                              .font('sm')
                              .weight('semibold')
                              .foreground(isActive ? 'primary' : 'muted'),
                            hasAlt
                              ? VStack()
                                  .frame({ width: '6', height: '6' })
                                  .background('primary')
                                  .corner('infinite')
                              : null,
                          )
                            .align('center')
                            .spacing('6')
                            .padding('horizontal', 'md')
                            .padding('vertical', '6')
                            .when(isActive, (v) => v.background('primary/10'))
                            .border(isActive ? 'primary' : 'border', 'thin')
                            .corner('infinite')
                            .onPress(() => setActiveTag(tag))
                            .role('tab')
                            .accessibilityState({ selected: isActive })
                            .pressFade('75'),
                          tag,
                        );
                      })}
                    </ScrollView>,
                  )
                : null,
              TextEditor([value, handleChange])
                .label(t('compose.altText.heading', { defaultValue: 'Alt text' }))
                .placeholder(
                  t('compose.altText.placeholder', { defaultValue: 'Describe this image…' }),
                )
                .maxLength(ALT_MAX_LENGTH)
                .showCount()
                .rows(5)
                .autoResize(12)
                .autoFocus()
                .autocapitalize('sentences')
                .autocorrect(true)
                .margin('horizontal', 'lg'),
            ),
          )}
        </ScrollView>,
      ),
      LButton(LText(t('common.done', { defaultValue: 'Done' })))
        .size('lg')
        .onPress(handleSave)
        .margin('horizontal', 'lg')
        // The web's button never drew its top margin; native's did.
        .when('native', (v) => v.margin('top', 'sm')),
    )
      .padding('bottom', '2xl')
      .background('background')
      .flex('1'),
  );
};

const scrollContentStyle = { paddingBottom: 24 };
const tabsContentStyle = { gap: 8, paddingHorizontal: 16, paddingBottom: 12 };

export default AltTextSheet;
