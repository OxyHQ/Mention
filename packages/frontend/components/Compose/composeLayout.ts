/**
 * Layout constants for the COMPOSE screen and its subcomponents.
 *
 * These are intentionally distinct from the feed list tokens
 * (`POST_ITEM_SPACING` in `styles/shared.ts`): the composer uses 16px horizontal
 * padding (vs the feed's 12px). The avatar size (40px) happens to match the feed,
 * but the two contexts are independent and may diverge — do not merge them.
 * The THREAD_LINE_* tokens below are context-independent and shared with PostItem.
 */
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { Icon, VStack, defineTokens } from '@oxy.so/bloom-language';
import { MEDIA_CARD_HEIGHT } from '@/utils/composeUtils';

export const HPAD = 16;
export const AVATAR_SIZE = 40;
const AVATAR_GAP = 12;
const AVATAR_OFFSET = AVATAR_SIZE + AVATAR_GAP; // 52
export const BOTTOM_LEFT_PAD = HPAD + AVATAR_OFFSET; // 68
export const TIMELINE_LINE_OFFSET = HPAD + AVATAR_SIZE / 2 - 1; // Center timeline on avatar
/**
 * The composer's measurements as the language names them: the attachments' inset under the
 * text, a media card's height and the thread line's offset (centred on the avatar).
 */
export const composeSpace = defineTokens({
  space: {
    bottomLeftPad: BOTTOM_LEFT_PAD,
    cardHeight: MEDIA_CARD_HEIGHT,
    timelineLine: TIMELINE_LINE_OFFSET,
  },
});
export const THREAD_LINE_WIDTH = 2;
export const THREAD_LINE_BORDER_RADIUS = 9999;
export const THREAD_LINE_Z_INDEX = -1;

/**
 * The thread timeline between two boxes: a faint primary line (Bloom's `primary` at 20%,
 * never a hex-alpha suffix on the colour) under the avatar, drawn below the box's content.
 * `below` runs from under the avatar (12 pad + 40 avatar + 8 gap) to the box's foot;
 * `above` reaches from the box's top to just above the avatar.
 */
export const timelineLineBelow = () =>
  VStack()
    .frame({ width: '2xs' })
    .background('primary/20')
    .corner('full')
    .position({ left: composeSpace.space.timelineLine, top: '5xl', bottom: 'none' })
    .zIndex('-1');
export const timelineLineAbove = () =>
  VStack()
    .frame({ width: '2xs', height: 'xs' })
    .background('primary/20')
    .corner('full')
    .position({ left: composeSpace.space.timelineLine, top: 'none' })
    .zIndex('-1');

/** An attachment card's remove control: a close glyph on a card-coloured disc over its top-right corner. */
export const cardRemoveControl = (onPress: () => void) =>
  VStack(Icon(RiCloseLine).size('sm').foreground('foreground'))
    .padding('6')
    .background('card')
    .corner('full')
    .position({ top: 'sm', right: 'sm' })
    .onPress(onPress)
    .pressFade();
