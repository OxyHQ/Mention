import { Link } from '@/lib/navigation/router';
import * as Clipboard from 'expo-clipboard';
import { toast } from '@oxy.so/bloom/toast';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { RiVerifiedBadgeFill } from '@oxy.so/bloom/icons/RiVerifiedBadgeFill';
import { VERIFIED_BADGE_COLOR } from '@/styles/colors';
import { AccountBadge } from '@/components/AccountBadge';
import type { UserNameProps, UserNameSize } from '@/components/Profile/types';
import {
  defineModifier,
  defineTokens,
  Embed,
  HStack,
  Icon,
  RawText,
  view,
  VStack,
  type FontSizeName,
  type IconSizeToken,
  type PaddingToken,
  type ViewModifier,
} from '@oxy.so/bloom-language';

/** The verified badge's blue, an app colour: the same in both schemes and under every preset. */
const BADGE = defineTokens({ color: { verified: VERIFIED_BADGE_COLOR } });

interface NameSize {
  /** The name's font size. */
  font: FontSizeName;
  /** The side of every glyph beside the name: the font size. */
  glyph: IconSizeToken;
  /** How far the glyphs sit below the row's centre, onto the text's baseline. */
  nudgeToken: PaddingToken;
  /** The account badge's nudge: on every platform, as its own view's offset. */
  badgeLook: ViewModifier;
}

/** A view nudged down onto the name's baseline. */
function nudged(y: PaddingToken): ViewModifier {
  return defineModifier((v) => v.offset({ y }));
}

/**
 * Each size of name. The glyphs are as large as the font, nudged down by 6%
 * of it (18% for the title size), rounded to a whole point.
 */
const NAME_SIZES: Record<UserNameSize, NameSize> = {
  sm: { font: '14', glyph: '14', nudgeToken: '1', badgeLook: nudged('1') },
  md: { font: 'md', glyph: '15', nudgeToken: '1', badgeLook: nudged('1') },
  lg: { font: '16', glyph: 'sm', nudgeToken: '1', badgeLook: nudged('1') },
  xl: { font: '24', glyph: 'lg', nudgeToken: 'xs', badgeLook: nudged('xs') },
};

/**
 * An account's name, its markers and its `@handle`, as one language view: placed
 * in a language tree it costs one fiber and one read of the environment and the
 * theme, and everything inside (the name's link, the badge, the glyphs) is part
 * of that tree. A caller places it with `look` (the column), `nameLook` and
 * `handleLook` (the handle's line), never a style object.
 */
const UserName = view(function UserName({
  name,
  handle,
  verified,
  isFederated,
  kind,
  isAgent,
  isAutomated,
  href,
  onPress,
  asHeading,
  onExplainNetwork,
  onExplainChannel,
  copyableHandle,
  size = 'md',
  align = 'start',
  look,
  nameLook,
  handleLook,
  lineSpacing,
  handleTrailing,
}: UserNameProps) {
  const { font, glyph, nudgeToken, badgeLook } = NAME_SIZES[size];

  // Opt-in centered layout (default `'start'` keeps every existing caller
  // byte-unchanged): center the name row + handle line for a stacked, centered
  // profile header.
  const isCentered = align === 'center';

  const copyHandle = async () => {
    if (!handle) return;
    await Clipboard.setStringAsync(`@${handle}`);
    toast('Copied to clipboard', { type: 'success' });
  };

  // Single source of truth for the "display name else handle, once" rule:
  //  - a real display name owns the bold primary slot, with the muted `@handle`
  //    line trailing below (as before);
  //  - with NO display name the `@handle` takes the bold primary slot ONCE and
  //    the separate muted handle line is suppressed (never blank, never doubled);
  //  - with neither, nothing renders.
  const hasName = !!name?.trim();
  const primaryText = hasName ? name : handle ? `@${handle}` : undefined;
  const showHandleLine = hasName && !!handle;

  // Handle line: the muted `@handle`, optionally with a passive inline element
  // (e.g. a "Follows you" tag) rendered to its right on the SAME line. With a
  // trailing element the handle sits in a row, which takes the caller's
  // `handleLook` (its bottom margin keeps the tag centred with the handle text),
  // and the handle shrinks first so it stays primary.
  const handleRun = RawText('@', handle).foreground('muted');
  const handleAligned = isCentered ? handleRun.textAlign('center') : handleRun;
  const handleText = (
    handleTrailing != null
      ? handleAligned.frame({ maxWidth: 'full', minWidth: 'none' }).shrink('normal')
      : handleAligned.frame({ maxWidth: 'full' })
  )
    .font('md')
    .leading('20px')
    .lines(1);
  const handleCopies = isFederated && copyableHandle;
  let handleLine = null;
  if (showHandleLine) {
    if (handleTrailing != null) {
      const row = HStack(
        handleCopies
          ? VStack(handleText)
              .frame({ minWidth: 'none' })
              .shrink('normal')
              .onPress(copyHandle)
              .pressFade('70')
          : handleText,
        Embed(handleTrailing),
      ).spacing('sm');
      handleLine = (isCentered ? row.justify('center') : row)
        .align('center')
        .frame({ minWidth: 'none' })
        .modifier(handleLook);
    } else {
      const text = handleText.modifier(handleLook);
      handleLine = handleCopies ? VStack(text).onPress(copyHandle).pressFade('70') : text;
    }
  }

  // The name, and with an `href` a link inside it: on web `<a>` within the
  // heading, never one element asked to be both (react-native-web renders
  // the role's tag, and an `<h1 href>` is not a link). The link takes the
  // name's style from the Text around it. The click stops at the link: a
  // name inside a pressable row must not also press the row.
  const nameRun = RawText(
    href
      ? // The link's child is the text's own host (Embed's render), so `asChild` hands it the
        // href, role and press: a boundary component in between would drop them.
        Embed((render) => (
          <Link
            href={href}
            push
            asChild
            onPress={(event) => {
              event.stopPropagation();
              onPress?.();
            }}
          >
            {render(RawText(primaryText))}
          </Link>
        ))
      : primaryText,
  )
    .foreground('foreground')
    .weight('bold')
    // Shrink (and ellipsize at one line) only when the parent constrains width;
    // a no-op when there is room, so unconstrained callers keep the name's
    // intrinsic width.
    .shrink('normal')
    .font(font)
    .lines(1);
  const nameText = (asHeading ? nameRun.role('header') : nameRun).modifier(nameLook);

  const nameLine = HStack(
    primaryText != null ? nameText : null,
    // The badge is always VERIFIED_BADGE_COLOR, never a theme role. It used to take
    // `text-primary`, which a profile scopes to the PROFILE OWNER's colour preset — so
    // the same seal was a different colour on every profile, and the compact scroll
    // header opted out into `text-foreground` on top of that, drawing it black/white a
    // few pixels above the very same badge in the identity line.
    verified
      ? Icon(RiVerifiedBadgeFill)
          .size(glyph)
          .foreground(BADGE.color.verified)
          // Natively only: a glyph's nudge was its icon's own style, which a Bloom
          // icon on the web drops (react-native-svg's web svg), so the web glyphs
          // have always sat on the row's centre.
          .when('native', (v) => v.offset({ y: nudgeToken }))
      : null,
    // One marker for the account's whole identity state — remote or channel, never
    // both, and nothing at all for an ordinary local account. Inert unless the
    // caller passed the handler for the marker it draws; forwarded, never chosen
    // between here.
    AccountBadge({
      isFederated,
      kind,
      onExplainNetwork,
      onExplainChannel,
      size: glyph,
      tone: 'foreground',
      look: badgeLook,
    }),
    isAgent
      ? Icon(RiSparklingLine)
          .size(glyph)
          .foreground('muted')
          .when('native', (v) => v.offset({ y: nudgeToken }))
      : null,
    isAutomated
      ? Icon(RiRobot2Line)
          .size(glyph)
          .foreground('muted')
          .when('native', (v) => v.offset({ y: nudgeToken }))
      : null,
  )
    // Centered identity stacks still constrain the row before text ellipsizes, and
    // the row may shrink below its content's width so the name can ellipsize.
    .frame({ maxWidth: 'full', minWidth: 'none' })
    .spacing('xs')
    .align('center');
  const nameRow = isCentered ? nameLine.justify('center') : nameLine;

  const stack = VStack(nameRow, handleLine);
  const column = lineSpacing ? stack.spacing(lineSpacing) : stack;
  return (isCentered ? column.align('center') : column)
    .frame({ minWidth: 'none', maxWidth: 'full' })
    .modifier(look);
});

export default UserName;
