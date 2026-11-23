import { chunk } from '@oxy.so/utils/text';
import type React from 'react';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  type ScrollViewInstance,
  type ViewStyle,
} from 'react-native';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EMOJI_CATEGORIES, MAX_RECENT_EMOJIS } from '@/utils/emojiData';
import { useColorTokens } from '@oxy.so/bloom/theme';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  Icon,
  RawText,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

const RECENT_EMOJIS_KEY = '@mention/recent_emojis';
const NUM_COLUMNS = 8;

interface EmojiPickerSheetProps {
  onClose: () => void;
  onSelectEmoji: (emoji: string) => void;
}

const EmojiPickerSheet: React.FC<EmojiPickerSheetProps> = ({ onClose, onSelectEmoji }) => {
  const { t } = useTranslation();
  const colorTokens = useColorTokens();
  const [activeCategory, setActiveCategory] = useState('smileys');
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);
  const scrollViewRef = useRef<ScrollViewInstance>(null);
  const sectionOffsets = useRef<Record<string, number>>({});

  // Load recent emojis from storage
  useEffect(() => {
    const loadRecent = async () => {
      try {
        const stored = await AsyncStorage.getItem(RECENT_EMOJIS_KEY);
        if (stored) {
          const parsed: string[] = JSON.parse(stored);
          setRecentEmojis(parsed);
        }
      } catch {
        // Silently ignore storage errors
      }
    };
    loadRecent();
  }, []);

  const saveRecentEmoji = useCallback(
    async (emoji: string) => {
      try {
        const updated = [emoji, ...recentEmojis.filter((e) => e !== emoji)].slice(
          0,
          MAX_RECENT_EMOJIS,
        );
        setRecentEmojis(updated);
        await AsyncStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(updated));
      } catch {
        // Silently ignore storage errors
      }
    },
    [recentEmojis],
  );

  const handleEmojiPress = useCallback(
    (emoji: string) => {
      onSelectEmoji(emoji);
      saveRecentEmoji(emoji);
      onClose();
    },
    [onSelectEmoji, saveRecentEmoji, onClose],
  );

  // Build categories with recent emojis populated
  const categories = useMemo(() => {
    return EMOJI_CATEGORIES.map((cat) => {
      if (cat.id === 'recent') {
        return { ...cat, emojis: recentEmojis };
      }
      return cat;
    }).filter((cat) => cat.emojis.length > 0);
  }, [recentEmojis]);

  const handleCategoryPress = useCallback((categoryId: string) => {
    setActiveCategory(categoryId);
    const offset = sectionOffsets.current[categoryId];
    if (offset !== undefined && scrollViewRef.current) {
      scrollViewRef.current.scrollTo({ y: offset, animated: true });
    }
  }, []);

  const handleSectionLayout = useCallback((categoryId: string, y: number) => {
    sectionOffsets.current[categoryId] = y;
  }, []);

  return toElement(
    VStack(
      Header(t('compose.emoji.title', { defaultValue: 'Emojis' }))
        .safeArea(false)
        .toolbar(
          LButton(Icon(RiCloseLine))
            .shape('circle')
            .style('subtle')
            .tint('neutral')
            .onPress(onClose)
            .label(t('common.close', { defaultValue: 'Close' })),
        )
        .inPage(),
      // Category tabs
      Embed(
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 8, gap: 4 }}
          style={[TABS, { borderColor: colorTokens.border }]}
        >
          {categories.map((cat) => (
            <TouchableOpacity
              key={cat.id}
              style={[
                TAB,
                { borderColor: activeCategory === cat.id ? colorTokens.primary : TRANSPARENT },
              ]}
              onPress={() => handleCategoryPress(cat.id)}
            >
              {toElement(RawText(cat.icon).font('xl').leading('28px'))}
            </TouchableOpacity>
          ))}
        </ScrollView>,
      ),
      // Emoji grid
      Embed(
        <ScrollView
          ref={scrollViewRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 16 }}
        >
          {categories.map((cat) => {
            const rows = chunk(cat.emojis, NUM_COLUMNS);
            return (
              <View
                key={cat.id}
                onLayout={(e) => handleSectionLayout(cat.id, e.nativeEvent.layout.y)}
              >
                {toElement(
                  VStack(
                    RawText(cat.name)
                      .font('sm')
                      .weight('semibold')
                      .textCase('uppercase')
                      .tracking('wide')
                      .foreground('muted'),
                  )
                    .padding('horizontal', 'lg')
                    .padding('top', 'md')
                    .padding('bottom', '6'),
                )}
                {rows.map((row, rowIndex) =>
                  toElement(
                    HStack(
                      Embed(
                        row.map((emoji, colIndex) => (
                          <TouchableOpacity
                            key={`${cat.id}-${rowIndex}-${colIndex}`}
                            style={styles.emojiCell}
                            onPress={() => handleEmojiPress(emoji)}
                            activeOpacity={0.6}
                          >
                            {toElement(RawText(emoji).font(EMOJI_FONT))}
                          </TouchableOpacity>
                        )),
                      ),
                      /* Fill remaining cells to maintain grid alignment */ Embed(
                        row.length < NUM_COLUMNS &&
                          Array.from({ length: NUM_COLUMNS - row.length }).map((_, i) => (
                            <View key={`pad-${i}`} style={styles.emojiCell} />
                          )),
                      ),
                    ).padding('horizontal', 'sm'),
                    rowIndex,
                  ),
                )}
              </View>
            );
          })}
        </ScrollView>,
      ),
    )
      .flex('1')
      .frame({ minHeight: sheetTokens.space.minHeight })
      .background('background'),
  );
};

/** The sheet's floor (`min-h-[350px]`): the grid has room before the emoji load. */
const sheetTokens = defineTokens({ space: { minHeight: 350 } });
/** Tailwind's 2.5 step, off Bloom's space scale. */
const SPACE_10 = 10;
/** Tailwind's `border-transparent`. */
const TRANSPARENT = '#0000';
/** The category strip (`border-b max-h-[48px]`), one line of glyphs. */
const TABS = { borderBottomWidth: 1, maxHeight: 48 } satisfies ViewStyle;
/** A category: its glyph over an underline (`px-2.5 py-2.5 border-b-2`). */
const TAB = {
  paddingHorizontal: SPACE_10,
  paddingVertical: SPACE_10,
  borderBottomWidth: 2,
} satisfies ViewStyle;

/** A glyph's size: 28pt on the web, 26pt on a device. */
const EMOJI_FONT = Platform.OS === 'web' ? '28' : '3xl';

const styles = StyleSheet.create({
  emojiCell: {
    flex: 1,
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default EmojiPickerSheet;
