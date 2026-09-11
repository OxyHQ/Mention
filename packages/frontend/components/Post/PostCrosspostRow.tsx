import React, { useCallback } from 'react';
import { GestureResponderEvent, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
// The SUBPATH, never the `@expo/vector-icons` barrel. The barrel re-exports
// every icon family, so importing one glyph through it pulls Zocial, EvilIcons,
// MaterialCommunityIcons and the rest of their fonts into the web bundle —
// measured at +2.27 MiB of fonts (+118%) when this file got it wrong, which is
// what the frontend bundle budget is there to catch. Every other one of the 65
// call sites in this app uses this form.
import Ionicons from '@expo/vector-icons/Ionicons';
import type { CrosspostProvenance } from '@mention/shared-types';
import { POST_CONTEXT_ROW_HEIGHT } from './postContextRowLayout';

/**
 * `Instagram · Threads` — one piece of writing that was published to two
 * networks, named on the card that renders it.
 *
 * ## Why the row names BOTH networks and not just the hidden one
 *
 * "Also on Threads" reads as a second, different post — which is exactly the
 * misunderstanding the collapse exists to prevent. Naming the whole set says
 * what actually happened: one thing, published twice, shown once. The rendered
 * variant is plain text and the others are tappable, so the row doubles as the
 * way to reach the version this card is not showing.
 *
 * ## The links are INTERNAL
 *
 * Both variants are real Mention posts with their own replies, likes and
 * moderation state — the collapse hides a card, it never discards an object — so
 * a hidden variant is reachable at `/p/<id>` like any other post. This
 * deliberately does not link out to instagram.com or threads.net: the reader
 * asked to see the other version of something they are already reading, not to
 * leave for a site that may ask them to log in.
 *
 * ## No engagement is shown here, and that is deliberate
 *
 * Each variant carries its own likes, replies and boosts, because those belong
 * to one object on one network. Putting a combined number on this row would
 * present a total no platform ever reported, so the row names networks and
 * nothing else. A reader who wants the other variant's numbers opens it.
 *
 * Renders `null` below two variants: one network is not provenance, it is simply
 * where the post is.
 */

interface Props {
  /** Straight off `post.crosspost` — the DTO, never a render prop. */
  crosspost: CrosspostProvenance;
  /** Colour for the leading glyph, from the active theme. */
  iconColor: string;
}

const PostCrosspostRow: React.FC<Props> = ({ crosspost, iconColor }) => {
  const router = useRouter();

  const openVariant = useCallback(
    (postId: string) => (event: GestureResponderEvent) => {
      // The row lives inside the post's own press target: opening the other
      // variant must never open the post detail underneath it as well.
      event.stopPropagation?.();
      router.push(`/p/${postId}`);
    },
    [router],
  );

  const variants = crosspost?.variants ?? [];
  if (variants.length < 2) return null;

  return (
    <View className="flex-row items-center" style={{ height: POST_CONTEXT_ROW_HEIGHT }}>
      <View className="-ml-4 mr-[3px]">
        <Ionicons name="git-compare-outline" size={13} color={iconColor} />
      </View>
      <Text
        className="text-muted-foreground text-[13px] font-semibold"
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {variants.map((variant, index) => (
          <React.Fragment key={variant.postId}>
            {index > 0 ? ' · ' : ''}
            {variant.rendered ? (
              variant.label
            ) : (
              <Text
                accessibilityRole="link"
                accessibilityLabel={variant.label}
                onPress={openVariant(variant.postId)}
                className="text-muted-foreground underline"
              >
                {variant.label}
              </Text>
            )}
          </React.Fragment>
        ))}
      </Text>
    </View>
  );
};

export default React.memo(PostCrosspostRow);
