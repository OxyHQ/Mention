import React, { type ComponentProps } from 'react';
// The SUBPATH, never the `@expo/vector-icons` barrel. The barrel re-exports
// every icon family, so importing one glyph through it pulls Zocial, EvilIcons,
// MaterialCommunityIcons and the rest of their fonts into the web bundle —
// measured at +2.27 MiB of fonts (+118%) when a call site got it wrong.
import BaseIonicons from '@expo/vector-icons/Ionicons';

export type IoniconsProps = ComponentProps<typeof BaseIonicons>;

/**
 * The app's one entry to the Ionicons glyph font. Import this, never
 * `@expo/vector-icons/Ionicons` directly (lint enforces it).
 *
 * A vector-icons glyph is a `Text` node whose content is a private-use code
 * point. A screen reader reads that node like any other text, so a button that
 * held one was announced as "\U000f036c, Talk" — and on Android the code point
 * is folded into the label of the pressable around it, because RN builds an
 * unlabelled accessible view's description from its children's text.
 *
 * Every glyph in this app is decorative: the control or row around it carries
 * the words. So the glyph is hidden from assistive technology here, once —
 * `aria-hidden` is `importantForAccessibility="no-hide-descendants"` on Android,
 * `accessibilityElementsHidden` on iOS and `aria-hidden` on web — rather than
 * at each call site, where the next icon would forget it. It is applied after
 * the caller's props so it cannot be switched back on by accident; a glyph that
 * genuinely needs a label belongs inside a control that has one.
 *
 * New icons should be Bloom's (SVG, `@oxy.so/bloom/icons/Ri*`); this covers the
 * Ionicons that remain.
 */
export default function Ionicons(props: IoniconsProps) {
  return <BaseIonicons {...props} aria-hidden />;
}
