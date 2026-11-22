import { chunk } from '@oxy.so/utils/text';
import type React from 'react';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  type ScrollViewInstance,
} from 'react-native';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EMOJI_CATEGORIES, MAX_RECENT_EMOJIS } from '@/utils/emojiData';
import { cn } from '@/lib/utils';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  Icon,
  RawText,
  VStack,
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

  return (
    <View className="flex-1 min-h-[350px] bg-background">
      {toElement(
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
      )}
      {/* Category tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, gap: 4 }}
        className="border-b border-border max-h-[48px]"
      >
        {categories.map((cat) => (
          <TouchableOpacity
            key={cat.id}
            className={cn(
              'px-2.5 py-2.5 border-b-2 border-transparent',
              activeCategory === cat.id && 'border-primary',
            )}
            onPress={() => handleCategoryPress(cat.id)}
          >
            {toElement(RawText(cat.icon).font('xl').leading('28px'))}
          </TouchableOpacity>
        ))}
      </ScrollView>
      {/* Emoji grid */}
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
                          <Text style={styles.emojiText}>{emoji}</Text>
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
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  emojiCell: {
    flex: 1,
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emojiText: {
    fontSize: Platform.OS === 'web' ? 28 : 26,
  },
});

export default EmojiPickerSheet;
