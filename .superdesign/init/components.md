# Shared Bloom primitives
Use canonical Bloom buttons, avatar, tabs and typography.
## node_modules/@oxy.so/bloom/src/button/index.ts
```tsx
export {
  Button,
  PrimaryButton,
  SecondaryButton,
  IconButton,
  GhostButton,
  TextButton,
  InverseButton,
  OutlineButton,
  LinkButton,
  DestructiveButton,
} from './Button';
export { CloseButton } from './CloseButton';
export { GlyphButton } from './GlyphButton';

export type {
  ButtonProps,
  ButtonSize,
  ButtonIconComponent,
  ButtonLinkTone,
  ButtonUnderline,
  LinkButtonProps,
  CloseButtonProps,
  GlyphButtonProps,
} from './types';

```

## node_modules/@oxy.so/bloom/src/avatar/index.ts
```tsx
export { Avatar } from './Avatar';
export { AvatarPlaceholderProvider } from './context';
export type { AvatarPlaceholderConfig } from './context';
export type {
  AvatarProps,
  AvatarSizeToken,
  AvatarColor,
  AvatarRingConfig,
} from './types';
export { defaultAvatarSource } from './default-avatar';
export { AVATAR_SIZES, resolveAvatarTint } from './initials';
export type { AvatarTint } from './initials';

```

## node_modules/@oxy.so/bloom/src/tabs/index.ts
```tsx
export { Tabs, TabsTrigger, TabsContent } from './Tabs';
export type { TabsDragController } from './Tabs';
export type {
  TabsProps,
  TabsTriggerProps,
  TabsContentProps,
  TabsVariant,
  TabsIconComponent,
} from './types';

```

## node_modules/@oxy.so/bloom/src/typography/index.ts
```tsx
export {
  Text,
  Span,
  H1,
  H2,
  H3,
  H4,
  H5,
  H6,
  P,
  Lead,
  Large,
  Small,
  Muted,
  Blockquote,
  fontFamilies,
} from './Typography';
export type { TextProps, BlockquoteProps } from './types';
export { TYPE_SCALE, typeScale } from './scale';
export type { TypeScaleFamily, TypeScaleStyle, TypeScaleVariant, TypeScaleWeight } from './scale';

```
## node_modules/@oxy.so/bloom/src/button/Button.tsx
```tsx
import { useSurfaceLayer } from '../surface/use-surface-layer';
import type { LinkButtonProps } from './types';
import React, { forwardRef, useMemo, useRef, useEffect, memo, type ComponentType } from 'react';
import { resolveIconSlot } from '../icons/render-icon';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SurfacePaint } from '../surface/SurfacePaint';
import { styled } from 'react-native-css';

import { useBloomAppearance } from '../appearance/context';
import { useTheme } from '../theme/use-theme';
import { Text } from '../typography/Typography';
import { useInteractionState } from '../hooks/use-interaction-state';
import { BUTTON_RADIUS, BUTTON_SHADOW, ICON_BUTTON_ICON_SIZE, LINK_BUTTON_GAP, isIconComponent, resolveLinkButtonPalette, resolveButtonGeometry, resolveButtonPalette, resolveButtonUnderline, type ButtonResolvedSize } from './shared';
import type { ButtonProps } from './types';

/** Raw text descendants need a native Text host; layout content stays unwrapped. */
function isTextContent(node: React.ReactNode): boolean {
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return true;
  if (Array.isArray(node)) return node.every(isTextContent);
  return React.isValidElement<{ children?: React.ReactNode }>(node) && node.type === React.Fragment && isTextContent(node.props.children);
}

/** Keep contiguous labels together so the button's gap only separates layout nodes. */
function renderTextContent(node: React.ReactNode, wrap: (text: React.ReactNode) => React.ReactNode): React.ReactNode {
  if (isTextContent(node)) return wrap(node);
  const result: React.ReactNode[] = [];
  let run: React.ReactNode[] = [];
  let runKey = '';
  const flush = () => {
    if (run.length) result.push(<React.Fragment key={runKey}>{wrap(run)}</React.Fragment>);
    run = [];
  };
  const visit = (children: React.ReactNode, path: string) => {
    React.Children.toArray(children).forEach((child, index) => {
      const key = `${path}/${React.isValidElement(child) ? child.key ?? index : index}`;
      if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment) {
        visit(child.props.children, key);
      } else if (typeof child === 'string' || typeof child === 'number') {
        if (!run.length) runKey = key;
        run.push(child);
      } else {
        flush();
        result.push(<React.Fragment key={key}>{child}</React.Fragment>);
      }
    });
  };
  visit(node, 'content');
  flush();
  return result;
}

export type {
  ButtonProps, LinkButtonProps,
  ButtonSize,
  ButtonIconComponent,
} from './types';

/**
 * Native fork of the button. Geometry and every state's colours come
 * from `./shared`, the same table `Button.web.tsx` reads.
 *
 */

/**
 * Vertical slack that brings each size's native touch target up to 44dp — the
 * floor `Checkbox` derives its own slack from, and the one Apple's HIG asks for.
 * Pinned as literals rather than derived from the height, because a value
 * computed from the thing it is checked against is checked by nothing:
 * `Button.test.tsx` asserts `height + 2 × top >= 44` for every size.
 *
 * Horizontal slack is deliberately ZERO — side slack is what makes two buttons
 * in a row steal each other's presses. Square buttons keep all-round slop.
 *
 * Native only: react-native-web drops `hitSlop`.
 */
const SIZE_HIT_SLOP = {
  xs: { top: 10, bottom: 10, left: 0, right: 0 },
  sm: { top: 6, bottom: 6, left: 0, right: 0 },
  md: { top: 4, bottom: 4, left: 0, right: 0 },
  lg: { top: 0, bottom: 0, left: 0, right: 0 },
} as const satisfies Record<ButtonResolvedSize, NonNullable<ButtonProps['hitSlop']>>;

/** A link hugs its 16–20px line box, so it needs the most vertical slack. */
const LINK_HIT_SLOP = { top: 12, bottom: 12, left: 0, right: 0 } as const;

const SQUARE_HIT_SLOP = {
  xs: { top: 10, bottom: 10, left: 10, right: 10 },
  sm: { top: 6, bottom: 6, left: 6, right: 6 },
  md: { top: 4, bottom: 4, left: 4, right: 4 },
  lg: { top: 0, bottom: 0, left: 0, right: 0 },
} as const satisfies Record<ButtonResolvedSize, NonNullable<ButtonProps['hitSlop']>>;

type HitSlop = { top: number; bottom: number; left: number; right: number };

/**
 * Android's floor is 48dp (Material), 4dp above the 44 the tables above reach —
 * so on Android every target grows 2dp at its top and bottom: `lg` (44dp tall,
 * no slack) reaches 48, and every smaller size clears 48 the same way. Squares
 * also grow 2dp at the sides, since they already take all-round slack; row
 * buttons and links do not, because side slack steals presses from a
 * neighbour. Two stacked buttons keep 4dp of every 8dp gap between them.
 */
const ANDROID_TARGET_EXTRA = 2;

function growVertical(slop: HitSlop): HitSlop {
  return { ...slop, top: slop.top + ANDROID_TARGET_EXTRA, bottom: slop.bottom + ANDROID_TARGET_EXTRA };
}

function growAllRound(slop: HitSlop): HitSlop {
  return {
    top: slop.top + ANDROID_TARGET_EXTRA,
    bottom: slop.bottom + ANDROID_TARGET_EXTRA,
    left: slop.left + ANDROID_TARGET_EXTRA,
    right: slop.right + ANDROID_TARGET_EXTRA,
  };
}

function mapSizes(
  table: Record<ButtonResolvedSize, HitSlop>,
  grow: (slop: HitSlop) => HitSlop,
): Record<ButtonResolvedSize, HitSlop> {
  return { xs: grow(table.xs), sm: grow(table.sm), md: grow(table.md), lg: grow(table.lg) };
}

const ANDROID_SIZE_HIT_SLOP = mapSizes(SIZE_HIT_SLOP, growVertical);
const ANDROID_SQUARE_HIT_SLOP = mapSizes(SQUARE_HIT_SLOP, growAllRound);
const ANDROID_LINK_HIT_SLOP = growVertical(LINK_HIT_SLOP);

// ---------------------------------------------------------------------------
//  The button renders ONE node — the same shape the web fork renders (one
//  `<button>`), so a caller's layout `className` lands on the box its parent
//  lays out. `styled()` comes from Bloom's own `react-native-css`, and both
//  wrappers are built ONCE at module scope so the element type is stable.
// ---------------------------------------------------------------------------

/**
 * Exactly the prop surface `Button` hands to the pressable — narrowing keeps
 * `styled()`'s dot-path mapping type from overflowing the checker (`TS2590`).
 */
type ButtonPressableProps = Pick<
  PressableProps,
  | 'accessibilityHint'
  | 'accessibilityLabel'
  | 'accessibilityRole'
  | 'accessibilityState'
  | 'children'
  | 'className'
  | 'disabled'
  | 'hitSlop'
  | 'onHoverIn'
  | 'onHoverOut'
  | 'onPress'
  | 'onLongPress'
  | 'onLayout'
  | 'accessibilityElementsHidden'
  | 'importantForAccessibility'
  | 'onPressIn'
  | 'onPressOut'
  | 'testID'
> & { style?: StyleProp<ViewStyle>; 'aria-hidden'?: boolean; 'aria-expanded'?: boolean; 'aria-pressed'?: boolean };

const ButtonPressable: ComponentType<ButtonPressableProps> = Pressable;

const StyledPressable: ComponentType<ButtonPressableProps & React.RefAttributes<View>> = styled(ButtonPressable, {
  className: 'style',
});

const ButtonComponent = forwardRef<View, ButtonProps>(function ButtonComponent({
  onPress,
  onLayout,
  'aria-hidden': ariaHidden,
  accessibilityElementsHidden,
  importantForAccessibility,
  colors,
  onLongPress,
  onPressIn,
  onPressOut,
  children,
  disabled = false,
  pressed: togglePressed,
  stopPropagation = false,
  appearance: appearanceProp,
  tone: toneProp,
  size: sizeProp,
  style,
  textStyle,
  icon,
  iconSize: iconSizeProp,
  leading,
  trailing,
  leadingIcon: LeadingIcon,
  trailingIcon: TrailingIcon,
  renderLeadingIcon,
  renderTrailingIcon,
  iconOnly = false,
  linkTone,
  underline,
  textVariant,
  numberOfLines,
  href,
  loading = false,
  loadingColor,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole,
  hitSlop,
  testID,
  className,
  'aria-expanded': ariaExpanded,
  'aria-haspopup': ariaHasPopup,
}, ref) {
  const theme = useTheme();
  const layer = useSurfaceLayer();
  const appearance = appearanceProp ?? 'solid';
  const { size, tone } = useBloomAppearance({ size: sizeProp, tone: toneProp }, { size: 'md', tone: 'accent' });
  const geometry = resolveButtonGeometry(size, textVariant);
  const isSquare = iconOnly || (icon != null && children == null);
  const isIconVariant = isSquare;
  const isLink = appearance === 'plain' && (href != null || linkTone != null);
  const isInteractionBlocked = disabled || loading;
  const iconSize = typeof iconSizeProp === 'number' && Number.isFinite(iconSizeProp) && iconSizeProp > 0 ? iconSizeProp : isIconVariant ? ICON_BUTTON_ICON_SIZE[size] : geometry.iconSize;
  const palette = useMemo(
    () => isLink && linkTone != null && toneProp == null ? resolveLinkButtonPalette(theme, linkTone) : resolveButtonPalette(appearance, theme, tone, colors, layer.fill),
    [appearance, theme, tone, toneProp, isLink, linkTone, colors, layer.fill],
  );
  const underlineMode = resolveButtonUnderline(isLink, underline);

  // Pressed state drives the ACTIVE palette. Tracked through state rather than
  // Pressable's function-form `style`, which NativeWind's css-interop swallows
  // (dropping every base style with it).
  const { state: pressed, onIn: onPressedIn, onOut: onPressedOut } =
    useInteractionState();
  // Hover exists on this fork too: a react-native-web (Metro-web) consumer
  // renders THIS file, and `linkTone="text"` is the first tone whose hover
  // changes the foreground rather than only a background the web fork's
  // stylesheet owned. On a real device no hover event is ever dispatched, so
  // `hovered` stays false and nothing about native changes.
  const { state: hovered, onIn: onHoveredIn, onOut: onHoveredOut } =
    useInteractionState();

  // No press scale: a 0.98 scale-down was deliberately left out, so a press is
  // the active paint alone.
  const previewActive = useRef(false);
  const pressOutCallback = useRef(onPressOut);
  pressOutCallback.current = onPressOut;
  const handlePressIn = isInteractionBlocked ? undefined : () => {
    onPressedIn();
    if (!previewActive.current) { previewActive.current = true; onPressIn?.(); }
  };
  const handlePressOut = () => {
    onPressedOut();
    if (previewActive.current) { previewActive.current = false; pressOutCallback.current?.(); }
  };
  useEffect(() => {
    if (isInteractionBlocked && previewActive.current) {
      previewActive.current = false;
      onPressedOut();
      pressOutCallback.current?.();
    }
  }, [isInteractionBlocked, onPressedOut]);
  useEffect(() => () => {
    if (previewActive.current) { previewActive.current = false; pressOutCallback.current?.(); }
  }, []);

  // A loading button keeps its rest paint under the spinner, like the web fork.
  const paint = disabled
    ? palette.disabled
    : (pressed || togglePressed) && !loading
      ? palette.active
      : hovered && !loading
        ? palette.hover
        : palette.rest;

  const baseStyles = useMemo((): ViewStyle => {
    const styles: ViewStyle = {
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: geometry.gap,
      height: geometry.height,
      paddingHorizontal: geometry.paddingHorizontal,
      borderRadius: BUTTON_RADIUS,
      borderWidth: palette.borderWidth,
      borderColor: paint.border,
      // The gradient is a child layer, so the box itself stays clear of it.
      backgroundColor: paint.surface ? 'transparent' : paint.background,
    };
    if (palette.shadow) {
      styles.boxShadow = BUTTON_SHADOW[theme.isDark ? 'dark' : 'light'];
    }
    if (disabled && palette.disabledOpacity != null) {
      styles.opacity = palette.disabledOpacity;
    }
    if (isSquare) {
      styles.width = geometry.height;
      styles.paddingHorizontal = 0;
    }
    if (isLink && !isSquare) {
      // LinkButton: no container — the label's own line box and a 4px
      // gap. The touch target comes back through `hitSlop`.
      styles.height = undefined;
      styles.paddingHorizontal = 0;
      styles.gap = LINK_BUTTON_GAP;
      styles.borderRadius = 4;
    }
    return styles;
  }, [geometry, palette, paint, theme.isDark, disabled, isSquare, isIconVariant, isLink]);

  // The type ramp step (size, line height, tracking, weight) comes from the
  // typography `Text` through `variant`; only the padding and colour are ours.
  const computedTextStyle = useMemo(
    (): TextStyle => ({
      paddingHorizontal: isLink ? 0 : geometry.labelPaddingHorizontal,
      color: paint.foreground,
      ...(underlineMode === 'rest' || (underlineMode === 'hover' && hovered && !disabled)
        ? { textDecorationLine: 'underline' as const }
        : null),
    }),
    [geometry, paint.foreground, isLink, underlineMode, hovered, disabled],
  );

  const android = Platform.OS === 'android';
  const defaultHitSlop = isSquare
    ? (android ? ANDROID_SQUARE_HIT_SLOP : SQUARE_HIT_SLOP)[size]
    : isLink
      ? (android ? ANDROID_LINK_HIT_SLOP : LINK_HIT_SLOP)
      : (android ? ANDROID_SIZE_HIT_SLOP : SIZE_HIT_SLOP)[size];

  const IconFromProp = icon != null && isIconComponent(icon) ? icon : null;
  const iconNode = IconFromProp ? (
    <IconFromProp width={iconSize} height={iconSize} fill={paint.foreground} />
  ) : (
    (icon as React.ReactNode) ?? null
  );

  const content = (
    <>
      {resolveIconSlot(renderLeadingIcon, iconSize, paint.foreground, () =>
        LeadingIcon ? (
          <LeadingIcon width={iconSize} height={iconSize} fill={paint.foreground} />
        ) : null,
      )}
      {leading}
      {iconNode}
      {children != null && (!isSquare || (!renderLeadingIcon && !LeadingIcon && !iconNode))
        ? renderTextContent(children, text => (
          <Text variant={textVariant ?? geometry.type} numberOfLines={numberOfLines} style={[computedTextStyle, textStyle]}>
            {text}
          </Text>
        )) : null}
      {trailing}
      {!isSquare
        ? resolveIconSlot(renderTrailingIcon, iconSize, paint.foreground, () =>
            TrailingIcon ? (
              <TrailingIcon width={iconSize} height={iconSize} fill={paint.foreground} />
            ) : null,
          )
        : null}
    </>
  );

  const handlePress = isInteractionBlocked
    ? undefined
    : onPress ?? (href != null ? () => void Linking.openURL(href) : undefined);

  return (
    <StyledPressable
      ref={ref}
      onLayout={onLayout}
      aria-hidden={ariaHidden}
      accessibilityElementsHidden={accessibilityElementsHidden}
      importantForAccessibility={importantForAccessibility}
      className={className}
      style={[
        baseStyles,
        style,
      ]}
      onLongPress={isInteractionBlocked ? undefined : onLongPress}
      onPress={handlePress ? event => {
        if (stopPropagation) event.stopPropagation();
        handlePress(event);
      } : undefined}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onHoverIn={isInteractionBlocked ? undefined : onHoveredIn}
      onHoverOut={isInteractionBlocked ? undefined : onHoveredOut}
      disabled={isInteractionBlocked}
      hitSlop={hitSlop ?? defaultHitSlop}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityRole={accessibilityRole ?? (href != null ? 'link' : 'button')}
      // `aria-busy` matches what `Button.web.tsx` emits; react-native-web never
      // reads `accessibilityState`, React Native folds `aria-busy` back into it.
      aria-busy={loading || undefined}
      aria-pressed={togglePressed}
      accessibilityState={{ disabled: isInteractionBlocked, busy: loading, ...(togglePressed === undefined ? {} : { selected: togglePressed }) }}
      // Forwarded from an anchored family's `asChild` trigger — see
      // `ButtonProps['aria-expanded']`.
      aria-expanded={ariaExpanded}
      {...(ariaHasPopup == null ? {} : { 'aria-haspopup': ariaHasPopup })}
      testID={testID}
    >
      {paint.surface ? (
        <SurfacePaint fill={paint.background} radius={StyleSheet.flatten(style)?.borderRadius ?? BUTTON_RADIUS} />
      ) : null}
      {loading ? (
        <>
          <View
            pointerEvents="none"
            style={styles.loadingHiddenContent}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            {content}
          </View>
          <View pointerEvents="none" style={styles.loadingOverlay}>
            <ActivityIndicator size="small" color={loadingColor ?? paint.foreground} />
          </View>
        </>
      ) : (
        content
      )}
    </StyledPressable>
  );
});

const styles = StyleSheet.create({
  loadingHiddenContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export const Button = memo(ButtonComponent);
Button.displayName = 'Button';

export const PrimaryButton = memo((props: ButtonProps) => (
  <Button appearance="solid" tone="accent" {...props} />
));
PrimaryButton.displayName = 'PrimaryButton';

export const SecondaryButton = memo((props: ButtonProps) => (
  <Button appearance="outline" tone="neutral" {...props} />
));
SecondaryButton.displayName = 'SecondaryButton';

export const IconButton = memo((props: ButtonProps) => (
  <Button appearance="outline" tone="neutral" {...props} iconOnly />
));
IconButton.displayName = 'IconButton';

export const GhostButton = memo((props: ButtonProps) => (
  <Button appearance="subtle" tone="accent" {...props} />
));
GhostButton.displayName = 'GhostButton';

export const InverseButton = memo((props: ButtonProps) => {
  const theme = useTheme();
  return <Button appearance="solid" tone="neutral" colors={props.appearance == null && props.tone == null ? { background: theme.colors.text, foreground: theme.colors.background } : undefined} {...props} />;
});
InverseButton.displayName = 'InverseButton';

export const TextButton = memo((props: ButtonProps) => (
  <Button appearance="plain" tone="accent" {...props} />
));
TextButton.displayName = 'TextButton';

// Named compositions share the canonical appearance and tone axes.
export const OutlineButton = memo((props: ButtonProps) => (
  <Button appearance="outline" tone="neutral" {...props} />
));
OutlineButton.displayName = 'OutlineButton';

/**
 * `LinkButton`: an inline text action — no fill, no border, the label
 * (plus icons) in the accent or secondary colour. `linkTone` is its colour; pass
 * `href` to open a URL.
 */
export const LinkButton = memo(({ linkTone = 'primary', ...props }: LinkButtonProps) => (
  <Button appearance="plain" {...props} linkTone={linkTone} />
));
LinkButton.displayName = 'LinkButton';

export const DestructiveButton = memo((props: ButtonProps) => (
  <Button appearance="solid" tone="danger" {...props} />
));
DestructiveButton.displayName = 'DestructiveButton';

```

## node_modules/@oxy.so/bloom/src/avatar/Avatar.tsx
```tsx
import { useContext } from 'react';
import { BloomAppearanceContext } from '../appearance/context';
import React, { memo, useMemo, useState } from 'react';
import { View, StyleSheet, Pressable, Platform } from 'react-native';
import type { TextStyle } from 'react-native';
import { imageSourcesKey } from './source-key';

import { useTheme } from '../theme/use-theme';
import { useMessages } from '../locale/messages';
import { useInteractionState } from '../hooks/use-interaction-state';
import { useImageResolver } from '../image-resolver/context';
import { isImageUrl } from '../image-resolver/is-image-url';
import { Z_INDEX } from '../styles/z-index';
import { useAvatarPlaceholder } from './context';
import { AVATAR_MESSAGES } from './messages';
import { LiveBadge } from './LiveBadge';
import { AvatarRing } from './AvatarRing';
import { Fill as ShapeFill, Image as ShapeImage } from '../shapes';
import type { Shape, ImageSource } from '../shapes';
import { Text } from '../typography';
import type { WebCssStyle } from '../styles/web-view-style';
import {
  avatarInitialsType,
  avatarTintForName,
  getInitial,
  resolveAvatarSize,
  resolveAvatarTint,
} from './initials';
import type { AvatarProps, AvatarRingConfig } from './types';

/**
 * `transition-[width,height,font-size] duration-200 ease` — web only;
 * native has no style transitions and a size change there is a relayout.
 */
const SIZE_TRANSITION: WebCssStyle =
  Platform.OS === 'web'
    ? {
        transitionProperty: 'width, height, font-size',
        transitionDuration: '200ms',
        transitionTimingFunction: 'ease',
      }
    : {};

// Built-in default avatar image — used when no source, fallbackSource, or placeholderIcon is provided.
// Sourced from a TypeScript module that exports an inlined base64 data URI, so no
// `.jpg` asset import (and no ambient `*.jpg` module declaration) is required for
// consumers compiling Bloom's source files directly.
import DEFAULT_AVATAR_IMAGE from './default-avatar';

function ShapeFallback({
  shape,
  alt,
  size,
  fallbackColor,
  icon,
  text,
  textColor,
}: {
  shape: Shape;
  alt?: string;
  size: number;
  fallbackColor: string;
  icon?: React.ReactNode;
  text?: string;
  textColor: string;
}) {
  const initialStyle: TextStyle = {
    ...avatarInitialsType(size),
    color: textColor,
    textAlign: 'center',
    includeFontPadding: false,
  };
  return (
    <View
      style={{
        width: size,
        height: size,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <ShapeFill shape={shape} size={size} color={fallbackColor} />
      </View>
      {icon ??
        (text ? (
          <Text allowFontScaling={false} numberOfLines={1} style={initialStyle}>
            {text}
          </Text>
        ) : (
          <ShapeImage
            source={DEFAULT_AVATAR_IMAGE}
            shape={shape}
            size={size}
            alt={alt}
          />
        ))}
    </View>
  );
}

/** Keyed by resolved source values, so failed images retry only when their request changes. */
function AvatarImageContent({
  primarySource,
  fallbackSource,
  ...placeholder
}: React.ComponentProps<typeof ShapeFallback> & {
  primarySource?: ImageSource;
  fallbackSource?: ImageSource;
}) {
  const [stage, setStage] = useState<'primary' | 'fallback' | 'placeholder'>(
    primarySource ? 'primary' : fallbackSource ? 'fallback' : 'placeholder',
  );
  const source =
    stage === 'primary'
      ? primarySource
      : stage === 'fallback'
        ? fallbackSource
        : undefined;
  if (!source) return <ShapeFallback {...placeholder} />;
  return (
    <ShapeImage
      key={stage}
      source={source}
      shape={placeholder.shape}
      size={placeholder.size}
      alt={placeholder.alt}
      onError={() =>
        setStage((current) =>
          current !== stage
            ? current
            : stage === 'primary' && fallbackSource
              ? 'fallback'
              : 'placeholder',
        )
      }
    />
  );
}

const AvatarComponent: React.FC<AvatarProps> = ({
  source,
  uri,
  variant = 'thumb',
  fallbackSource,
  size: sizeProp,
  color,
  initials,
  alt,
  verified = false,
  verifiedIcon,
  shape = 'circle',
  style,
  placeholderColor,
  placeholderIcon,
  name,
  onPress,
  live = false,
  hideLiveBadge = false,
  liveLabel: liveLabelProp,
  liveColor,
  ring,
  testID,
}) => {
  // The press dip goes through the shared interaction hook rather than
  // `TouchableOpacity`'s `activeOpacity` — one mechanism across the library, and
  // the one the reduced-motion / pointer-type guards live behind.
  const {
    state: pressed,
    onIn: onPressIn,
    onOut: onPressOut,
  } = useInteractionState();
  const theme = useTheme();
  const { messages } = useMessages(AVATAR_MESSAGES);
  const liveLabel = liveLabelProp ?? messages.live;
  const placeholderConfig = useAvatarPlaceholder();
  const scope = useContext(BloomAppearanceContext);
  const size = resolveAvatarSize(sizeProp ?? scope.size);
  const hasName = typeof name === 'string' && name.trim().length > 0;
  const hasInitials =
    typeof initials === 'string' && initials.trim().length > 0;
  // The fallback text: explicit `initials` > the first letter of `name`.
  const fallbackText = hasInitials
    ? initials.trim()
    : hasName
      ? getInitial(name)
      : undefined;
  // The tint: explicit `color` > deterministic from `name` > neutral.
  const tint = useMemo(
    () =>
      resolveAvatarTint(
        theme,
        color ??
          (hasName && !hasInitials ? avatarTintForName(name) : 'neutral'),
      ),
    [theme, color, hasName, hasInitials, name],
  );
  // Priority: explicit placeholderColor > the tint. A caller's own colour gets
  // a white letter (Bloom cannot know its contrast) unless a tint is also named.
  const fallbackColor = placeholderColor || tint.background;
  const fallbackTextColor =
    placeholderColor && !color ? '#FFFFFF' : tint.foreground;
  // With fallback text we render it instead of invoking the default
  // placeholder-context icon. Explicit placeholderIcon still wins.
  const resolvedPlaceholderIcon =
    placeholderIcon ??
    (fallbackText ? undefined : placeholderConfig?.icon?.(size * 0.6));

  const imageResolver = useImageResolver();

  // Resolve source prop: string → uri, object → ImageSource.
  // A URL passes through directly (`isImageUrl`, the package's one answer to
  // "URL or id"). Non-URL strings (e.g. Oxy file IDs) are resolved via the
  // app-provided ImageResolver if available, with the requested `variant`
  // forwarded so the resolver (the single URL chokepoint) can build the right
  // rendition. `variant` defaults to `'thumb'` (see prop default) so a bare-id
  // avatar never accidentally requests the full-size original; callers wanting
  // the full image pass an explicit variant.
  // Resolve on each render: a stable resolver can read refreshed URL data.
  const resolvedUri =
    typeof source === 'string'
      ? isImageUrl(source)
        ? source
        : imageResolver?.(source, variant)
      : source != null
        ? undefined
        : uri;

  const resolvedImageSource = useMemo(() => {
    if (source != null && typeof source !== 'string') return source;
    return undefined;
  }, [source]);

  const primarySource = useMemo(
    () => (resolvedUri ? { uri: resolvedUri } : resolvedImageSource),
    [resolvedUri, resolvedImageSource],
  );

  // Resolve a SINGLE ring config shared by `live` and the public `ring` prop.
  // An explicit `ring` wins for geometry and colors; otherwise `live` derives a
  // solid theme-`negative` ring (modeled on Bluesky's live indicator). The
  // "LIVE" badge stays independently controlled by `live` / `hideLiveBadge` and
  // uses the theme `negative` color regardless of the ring's colors.
  const liveBadgeColor = liveColor ?? theme.colors.negative;
  const resolvedRing: AvatarRingConfig | undefined = ring
    ? ring
    : live
      ? { colors: liveBadgeColor, width: size > 16 ? 2 : 1 }
      : undefined;
  const ringWidth = resolvedRing?.width ?? (size > 16 ? 2 : 1);
  const showLiveBadge = live && size > 16 && !hideLiveBadge;

  const ringElement = resolvedRing ? (
    <AvatarRing
      size={size}
      shape={shape}
      colors={resolvedRing.colors}
      width={ringWidth}
      gradientDirection={resolvedRing.gradientDirection ?? 'diagonal'}
    />
  ) : null;

  const avatarBox = (
    <View
      style={[styles.avatarBox, SIZE_TRANSITION, { width: size, height: size }]}
    >
      <AvatarImageContent
        key={imageSourcesKey(primarySource, fallbackSource)}
        primarySource={primarySource}
        fallbackSource={fallbackSource}
        shape={shape}
        size={size}
        alt={alt}
        fallbackColor={fallbackColor}
        icon={resolvedPlaceholderIcon}
        text={fallbackText}
        textColor={fallbackTextColor}
      />
      {ringElement}

      {verified && verifiedIcon && (
        <View
          style={[
            styles.verifiedBadge,
            {
              width: size * 0.36,
              height: size * 0.36,
            },
          ]}
        >
          {verifiedIcon}
        </View>
      )}

      {showLiveBadge && (
        <LiveBadge
          variant={size > 32 ? 'small' : 'tiny'}
          label={liveLabel}
          backgroundColor={liveBadgeColor}
          textColor={theme.colors.negativeForeground}
        />
      )}
    </View>
  );

  const content = (
    <View
      style={[styles.container, { width: size, height: size }, style]}
      testID={testID}
    >
      {avatarBox}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        accessibilityRole="button"
        accessibilityLabel={alt ?? (hasName ? name : undefined)}
        style={pressed ? styles.pressed : undefined}
      >
        {content}
      </Pressable>
    );
  }

  return content;
};

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.7,
  },
  container: {
    position: 'relative',
    overflow: 'visible',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarBox: {
    position: 'relative',
    overflow: 'visible',
    justifyContent: 'center',
    alignItems: 'center',
  },
  verifiedBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: Z_INDEX.raised,
  },
});

export const Avatar = memo(AvatarComponent);
Avatar.displayName = 'Avatar';

```

## node_modules/@oxy.so/bloom/src/tabs/Tabs.tsx
```tsx
import { webDataSet } from '../styles/web-data';
import React, {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import {
  View,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  type LayoutRectangle,
  type TextStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { useTheme } from '../theme/use-theme';
import type { Theme } from '../theme/types';
import { Text } from '../typography';
import { TYPE_SCALE } from '../typography/scale';
import { useInteractionState } from '../hooks/use-interaction-state';
import { borderRadius } from '../styles/tokens';
import { hairlineOn, surfaceFillOn, useSurfaceFill } from '../styles/surface-levels';
import { interactiveWebCss, useInteractiveWebCss } from '../styles/interactive-web-css';
import { handleRovingKeyDown, useRovingTabIndex } from '../hooks/roving-focus';
import type { WebCssStyle } from '../styles/web-view-style';
import type {
  TabsContentProps,
  TabsIconComponent,
  TabsProps,
  TabsTriggerProps,
  TabsVariant,
} from './types';

/**
 * Tabs and its pill tab switcher.
 * Colours are Bloom's theme through the button recipe (`button/shared.ts`
 * ramps).
 *
 * `underline` — `Tab`:
 *   strip      gap 4, 1px separator baseline (neutral-200 / dark neutral-800)
 *   trigger    px 10, py 8, gap 10 (label group ↔ count)
 *   label      gap 6 with a 16px icon; selected body-medium accent-600,
 *              idle body-regular text-primary. The icon takes the label colour.
 *   count      radius 4, px 4, py 1, caption-1-medium.
 *              selected: accent-100 (dark accent-800 @60%) on accent-600.
 *              idle:     black/10 on text-primary, the whole badge at 50%.
 *   underline  2px accent-600 laid OVER the baseline, sliding 200ms `ease`.
 *
 * `pill` / `filled` — `PillTab` blue / gray:
 *   strip      gap 4, no chrome
 *   trigger    px 8, py 5, gap 4, 20px icon, body-medium label
 *   idle       label + icon neutral-500; a hover layer fades in over 200ms
 *              (blue: neutral-100 / dark neutral-800; gray: neutral-100 /
 *              dark neutral-700 @60%)
 *   selected   a thumb slides between pills over 300ms with a small overshoot
 *              (`cubic-bezier(0.34, 1.2, 0.64, 1)`).
 *              blue: accent-50 (dark accent-950 @60%), label + icon accent-500
 *              gray: neutral-200 (dark neutral-800), label + icon text-primary
 *
 * `outlined` is kept for existing call sites and renders as `pill`.
 *
 * Both pill variants are FULL pills (Bloom's rule for button-like controls);
 * the gray one is not given a smaller corner radius. No press scale; press
 * borrows the hover paint on native. Every slide and fade is skipped under
 * reduced motion.
 */

type TriggerLayout = Pick<LayoutRectangle, 'x' | 'width'>;

/**
 * Re-read ONE trigger's geometry from the platform and report it back.
 *
 * A callback rather than a return value because measuring is asynchronous on
 * both platforms: react-native-web defers to a `setTimeout(0)` inside
 * `UIManager.measure`, and native hops to the UI thread. Each trigger keeps its
 * own host ref and hands the strip this instead, so the registry says exactly
 * what it needs — a position on demand — and nothing about what a trigger
 * renders.
 */
type TriggerMeasure = (report: (layout: TriggerLayout) => void) => void;

/** The underline: `transition-[transform,width] duration-200 ease`. */
const UNDERLINE_TIMING = { duration: 200, easing: Easing.bezier(0.25, 0.1, 0.25, 1) };

/** The pill thumb: 300ms with a spring-like settle. */
const PILL_TIMING = { duration: 300, easing: Easing.bezier(0.34, 1.2, 0.64, 1) };

/** Visibility, not travel — the indicator fades, it does not slide, in and out. */
const HIGHLIGHT_FADE = { duration: 160 };

/** `transition-colors duration-150 ease` on a trigger's label. */
const COLOR_TRANSITION_MS = 150;

/** The pill hover layer, `transition-opacity duration-200 ease-out`. */
const HOVER_FADE_MS = 200;

/**
 * How long after an animated selection a re-measured trigger keeps animating
 * instead of snapping. A selection changes the label WEIGHT (regular → medium),
 * which resizes the trigger a frame after the slide started; snapping on that
 * report would cut the slide off mid-flight. Covers the longer of the two
 * timings.
 */
const SELECTION_SETTLE_MS = 320;

/**
 * Fraction of the distance to the neighbour a drag must cover before releasing
 * commits. Below it the underline springs home and nothing navigates.
 */
const COMMIT_THRESHOLD = 0.4;

/**
 * How far the underline may stray past the first/last tab, and how heavily that
 * travel is damped. A rubber-band is reserved for the edge, where "there is
 * nothing there" is the true message; used anywhere else it would promise a
 * neighbour that is about to arrive, which is the opposite of what happens.
 */
const EDGE_RUBBER_BAND_DAMPING = 0.25;
const EDGE_RUBBER_BAND_MAX = 32;

/** Above this the count renders as "99+", so a large tally cannot stretch a tab. */
const MAX_DISPLAYED_COUNT = 99;

function formatCount(count: number): string {
  return count > MAX_DISPLAYED_COUNT ? `${MAX_DISPLAYED_COUNT}+` : String(count);
}

/** `outlined` is a legacy alias and renders as the accent pill. */
type ResolvedVariant = 'underline' | 'pill' | 'filled';

function resolveVariant(variant: TabsVariant): ResolvedVariant {
  return variant;
}

export interface TabsPaint {
  /** The strip's 1px baseline (`underline`). */
  separator: string;
  /** The 2px underline. */
  underline: string;
  /** The sliding pill thumb. */
  thumb: string;
  /** The idle pill's hover layer. */
  hover: string;
  selectedLabel: string;
  selectedIcon: string;
  idleLabel: string;
  idleIcon: string;
  countSelectedBackground: string;
  countSelectedForeground: string;
  countIdleBackground: string;
  countIdleForeground: string;
  /** Keyboard focus ring (`border-focus-ring`, accent-500). */
  ring: string;
}

/**
 * Every colour a strip paints, per variant. Pure — takes the theme rather than
 * calling `useTheme()`, so it can be walked over presets and modes.
 */
export function resolveTabsPaint(theme: Theme, variant: TabsVariant, surface = theme.colors.background): TabsPaint {
  const c = theme.colors;
  const raised = surfaceFillOn(theme, surface);
  const hairline = hairlineOn(theme, surface);
  const count = {
    countSelectedBackground: c.primarySubtle,
    countSelectedForeground: c.primarySubtleForeground,
    countIdleBackground: c.backgroundTertiary, countIdleForeground: c.text,
    separator: hairline, underline: c.primary, ring: c.primary,
  };
  switch (resolveVariant(variant)) {
    case 'underline':
      return { ...count, thumb: 'transparent', hover: 'transparent',
        selectedLabel: c.primarySubtleForeground, selectedIcon: c.primarySubtleForeground,
        idleLabel: c.text, idleIcon: c.text };
    case 'pill':
      return { ...count, thumb: c.primarySubtle, hover: surfaceFillOn(theme, raised),
        selectedLabel: c.primarySubtleForeground, selectedIcon: c.primarySubtleForeground,
        idleLabel: c.textSecondary, idleIcon: c.textSecondary };
    case 'filled':
    default:
      return { ...count, thumb: raised, hover: surfaceFillOn(theme, raised),
        selectedLabel: c.text, selectedIcon: c.text,
        idleLabel: c.textSecondary, idleIcon: c.textSecondary };
  }
}

/** Per-variant trigger geometry (`Tab` vs `PillTab`). */
const GEOMETRY = {
  underline: { paddingHorizontal: 10, paddingVertical: 8, gap: 10, labelGap: 6, icon: 16, radius: 4 },
  pill: { paddingHorizontal: 8, paddingVertical: 5, gap: 4, labelGap: 4, icon: 20, radius: borderRadius.full },
  filled: { paddingHorizontal: 8, paddingVertical: 5, gap: 4, labelGap: 4, icon: 20, radius: borderRadius.full },
} as const;

/** The strip's gap between triggers (`gap-1`), both variants. */
const STRIP_GAP = 4;

const IS_WEB = Platform.OS === 'web';

// ---------------------------------------------------------------------------
//  Web: keyboard focus ring, colour transitions, disabled cursor
//
//  A trigger is a react-native-web `Pressable`, so no inline style can carry
//  `:focus-visible` or a transition keyed to a state change. The hook is a
//  `data-*` attribute through `dataSet` because a class never reaches the DOM
//  (react-native-css consumes `className`). `base` puts the LAYOUT half of the
//  shared reset back, which is written for a raw `<button>`.
// ---------------------------------------------------------------------------

const STYLE_ID = 'bloom-tabs-web-css';
const TRIGGER = '[data-bloom-tabs-trigger]';
/** The strip — the owner a trigger's keyboard walks within. */
const STRIP = '[data-bloom-tabs-strip]';

function isSelectedTab(element: HTMLElement): boolean {
  return element.getAttribute('aria-selected') === 'true';
}

const BLOOM_TABS_CSS = interactiveWebCss({
  selector: TRIGGER,
  varPrefix: 'bloom-tabs',
  base: `
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    position: relative;
    white-space: nowrap;
  `,
  transition: 'none',
  hover: { declarations: 'opacity: 1;' },
  outlineOffset: 0,
  extraRules: `${TRIGGER}:disabled,
${TRIGGER}[aria-disabled="true"] {
  cursor: not-allowed;
}
${TRIGGER} [data-bloom-tabs-label],
${TRIGGER} [data-bloom-tabs-icon] {
  transition: color ${COLOR_TRANSITION_MS}ms ease;
}
[data-bloom-tabs-hover] {
  transition: opacity ${HOVER_FADE_MS}ms ease-out;
}
@media (prefers-reduced-motion: reduce) {
${TRIGGER} [data-bloom-tabs-label],
${TRIGGER} [data-bloom-tabs-icon],
[data-bloom-tabs-hover] {
  transition: none;
}
}`,
});

interface TabsContextValue {
  /**
   * The selected value on the CONTROLLED path, `undefined` on the focus-driven
   * one. Which of the two is in play is the whole discriminator — see
   * {@link TabsProps.value} — and it decides who may write the underline's
   * shared values, so there is never more than one writer.
   */
  selectedValue: string | undefined;
  onValueChange: ((value: string) => void) | undefined;
  variant: ResolvedVariant;
  paint: TabsPaint;
  fullWidth: boolean;
  /**
   * A trigger hands the strip a way to RE-READ its own geometry, and takes it
   * back on unmount. See `remeasureTriggers` for why the strip cannot simply
   * keep whatever `onLayout` last reported.
   */
  registerTrigger: (value: string, measure: TriggerMeasure) => () => void;
  /** A trigger reports the geometry its own `onLayout` just handed it. */
  reportTriggerLayout: (value: string, layout: TriggerLayout) => void;
  /** A trigger reports that the ROUTER considers it focused. */
  reportFocused: (value: string) => void;
  /**
   * What an arrow key does on web: `follow` selects the tab it lands on
   * (automatic activation, the controlled path), `manual` only moves focus and
   * leaves Enter/Space to select (the focus-driven path, where selecting is a
   * navigation). See `TabsProps.value`.
   */
  activation: 'follow' | 'manual';
}

const TabsContext = createContext<TabsContextValue | null>(null);

/**
 * The imperative surface a horizontal drag gesture drives the underline through.
 *
 * It lives here rather than in the gesture's own code because every quantity the
 * drag needs — where the neighbouring trigger is, how wide it is, whether there
 * IS a neighbour — is measured layout the strip already holds and nothing
 * outside it can see. The gesture supplies one number, the finger's delta; the
 * strip decides what that means.
 *
 * Obtained via a `ref` on `Tabs`. The gesture belongs in the LAYOUT beside the
 * strip, never inside a tab screen — a gesture mounted in a screen is destroyed
 * by the navigation it commits, mid-release.
 */
export interface TabsDragController {
  /**
   * Feed the raw horizontal finger delta (`translationX`).
   *
   * The underline travels OPPOSITE the finger, because that is where the
   * incoming tab is: dragging left reveals the NEXT tab, which sits to the
   * right. Travel is clamped at the neighbour — the underline stops exactly
   * where it would land, so it never promises more than the release delivers —
   * and at the first/last tab it rubber-bands instead.
   *
   * Returns the value that releasing NOW would commit, or `null` for "no
   * commit": either the drag has not passed the threshold, or there is no
   * neighbour in that direction.
   */
  drag(translationX: number): string | null;
  /**
   * End the drag. Pass the value `drag` last returned to keep the underline
   * where the finger left it while the caller navigates; pass `null` to spring
   * it home.
   *
   * On a commit the offset is FOLDED into the underline's base position rather
   * than zeroed, so the focus change that follows springs from where the finger
   * actually let go. Zeroing first would snap backwards for a frame and then
   * animate forwards from the wrong place.
   */
  release(committed: string | null): void;
}

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error(`${component} must be used within a Tabs`);
  }
  return ctx;
}

const TabsBarComponent = forwardRef<TabsDragController, TabsProps>(function TabsBar(
  {
    value,
    onValueChange,
    hasSelection = true,
    variant = 'underline',
    fullWidth = false,
    label,
    children,
    style,
    testID,
  },
  dragRef,
) {
  const theme = useTheme();
  useInteractiveWebCss(STYLE_ID, BLOOM_TABS_CSS);
  const resolvedVariant = resolveVariant(variant);
  const isUnderline = resolvedVariant === 'underline';
  const surface = useSurfaceFill();
  const paint = useMemo(() => resolveTabsPaint(theme, variant, surface), [theme, variant, surface]);
  const reducedMotion = useReducedMotion();
  const slideTiming = isUnderline ? UNDERLINE_TIMING : PILL_TIMING;

  // One shared underline that translates + resizes between triggers. Triggers
  // report their measured {x, width}; whoever owns the selection drives these
  // shared values IMPERATIVELY, and `useAnimatedStyle` below only ever READS
  // them. That split is what makes the animation work on web, where returning
  // an animation from inside a mapper silently does nothing.
  const indicatorX = useSharedValue(0);
  const indicatorWidth = useSharedValue(0);
  // Starts hidden: a strip whose active trigger has not been measured yet must
  // not flash an underline at the origin on its first frame.
  const indicatorOpacity = useSharedValue(0);
  // Live drag, added to the settled position/width rather than replacing them,
  // so a release can fold the delta into the base without a visible jump.
  const dragOffset = useSharedValue(0);
  const dragWidthDelta = useSharedValue(0);

  const triggerLayoutsRef = useRef<Record<string, TriggerLayout>>({});
  // How to ask each trigger where it is NOW, keyed by value. Registration order
  // carries no meaning — everything that consumes the geometry orders itself by
  // measured `x`, which is the only ordering that survives a reorder.
  const triggerMeasuresRef = useRef(new Map<string, TriggerMeasure>());
  const remeasureScheduledRef = useRef(false);
  const indicatorPlacedRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const stripRef = useRef<View>(null);
  const viewportWidthRef = useRef(0);
  // The value the underline currently belongs to, from EITHER path. A ref
  // because the layout callback below must see the latest selection without
  // being re-created — and therefore re-firing — on every selection change.
  const selectedValueRef = useRef<string | undefined>(value);

  // Until when a re-measure of the selection should keep animating rather than
  // snap — see `SELECTION_SETTLE_MS`.
  const settleUntilRef = useRef(0);

  const moveIndicator = useCallback(
    (target: TriggerLayout, animate: boolean) => {
      if (animate && !reducedMotion) {
        indicatorX.value = withTiming(target.x, slideTiming);
        indicatorWidth.value = withTiming(target.width, slideTiming);
      } else {
        indicatorX.value = target.x;
        indicatorWidth.value = target.width;
      }
      // Reveal only while something IS selected. Geometry keeps arriving while
      // a non-tab sibling route is showing — the measurement pass below is
      // precisely what makes it arrive — and fading the underline back in there
      // would re-assert a tab the reader has left. Read from the closure rather
      // than a ref: a ref written in an effect is still stale at this point,
      // because a child's effect runs before its parent's.
      if (!hasSelection) return;
      indicatorOpacity.value = withTiming(1, HIGHLIGHT_FADE);
    },
    [indicatorX, indicatorWidth, indicatorOpacity, hasSelection, reducedMotion, slideTiming],
  );

  // Keep the active tab in view when the strip overflows its viewport. Centring
  // is what makes a ROUTED strip usable: arriving at a tab that is scrolled out
  // of sight — via a deep link, a Back, or simply a long tab set — must not
  // look like an empty selection.
  const revealTrigger = useCallback(
    (target: TriggerLayout, animate: boolean) => {
      const viewport = viewportWidthRef.current;
      if (fullWidth || viewport <= 0) return;
      const centred = target.x + target.width / 2 - viewport / 2;
      scrollRef.current?.scrollTo({ x: Math.max(0, centred), animated: animate });
    },
    [fullWidth],
  );

  const applySelection = useCallback(
    (tabValue: string) => {
      const target = triggerLayoutsRef.current[tabValue];
      // Not measured yet — `reportTriggerLayout` places it on arrival.
      if (!target) return;
      const animate = indicatorPlacedRef.current;
      if (animate) settleUntilRef.current = Date.now() + SELECTION_SETTLE_MS;
      moveIndicator(target, animate);
      revealTrigger(target, animate);
      indicatorPlacedRef.current = true;
    },
    [moveIndicator, revealTrigger],
  );

  /**
   * Record where a trigger is, from whichever source measured it, and keep the
   * underline glued to it.
   *
   * Placement here never animates: the tab did not become SELECTED, it MOVED,
   * and it moved instantly because nothing animates a strip's reflow. Sliding
   * the underline across would read as a selection change that never happened.
   */
  const applyTriggerLayout = useCallback(
    (tabValue: string, layout: TriggerLayout) => {
      const previous = triggerLayoutsRef.current[tabValue];
      // Unchanged geometry must be a no-op, not a re-place: a measurement pass
      // runs after every render, and re-placing would cancel a selection slide
      // mid-flight for no reason.
      if (previous !== undefined && previous.x === layout.x && previous.width === layout.width) {
        return;
      }
      triggerLayoutsRef.current[tabValue] = layout;
      if (tabValue !== selectedValueRef.current) return;
      // The one exception: a selection that is still sliding. Selecting changes
      // the label's weight, so the trigger re-reports a new width a frame into
      // the slide — retarget it rather than cutting it off.
      moveIndicator(layout, Date.now() < settleUntilRef.current);
      revealTrigger(layout, false);
      indicatorPlacedRef.current = true;
    },
    [moveIndicator, revealTrigger],
  );

  /**
   * Re-read EVERY trigger's position from the platform.
   *
   * This exists because `onLayout` cannot be trusted to report a MOVE. On
   * react-native-web it is backed by a single `ResizeObserver`
   * (`modules/useElementLayout`), which fires for a SIZE change and never for a
   * position-only one — so a trigger inserted, removed or reordered after first
   * layout shifts every trigger after it while not one of them re-reports, and
   * the underline stays where the stale numbers put it: silently, one tab off,
   * only on the first paint after an async tab list lands. A tab whose own
   * width changes has the same effect on its neighbours.
   *
   * So `onLayout` is demoted to a change SIGNAL and the geometry is read back
   * explicitly, through the `measure` both platforms put on a host view ref. It
   * answers in the view's PARENT coordinate space, which is the space the
   * underline is positioned in and the same one `onLayout` reports — the two
   * sources cannot disagree about what they mean.
   */
  const remeasureTriggers = useCallback(() => {
    for (const [tabValue, measure] of triggerMeasuresRef.current) {
      measure((layout) => {
        // A strip that is mounted but not laid out — a `display: none` ancestor
        // on web, an unmeasured subtree on native — measures as zero, and a
        // trigger cannot genuinely be zero-wide (it always carries horizontal
        // padding). Recording that would collapse the underline and throw away
        // the real geometry, so the last known position stands until it is on
        // screen again.
        if (layout.width <= 0) return;
        applyTriggerLayout(tabValue, layout);
      });
    }
  }, [applyTriggerLayout]);

  const scheduleRemeasure = useCallback(() => {
    // One pass per turn, however many signals arrive: a mount registers N
    // triggers and reports N layouts, which is N+1 reasons to measure the same
    // frame. A microtask, so the pass is queued before the browser paints the
    // frame the change landed in.
    if (remeasureScheduledRef.current) return;
    remeasureScheduledRef.current = true;
    queueMicrotask(() => {
      remeasureScheduledRef.current = false;
      remeasureTriggers();
    });
  }, [remeasureTriggers]);

  const registerTrigger = useCallback((tabValue: string, measure: TriggerMeasure) => {
    triggerMeasuresRef.current.set(tabValue, measure);
    return () => {
      triggerMeasuresRef.current.delete(tabValue);
      // A tab that is gone must not keep a position in the geometry the drag
      // controller orders itself by, or a swipe can commit to a trigger that is
      // no longer on screen.
      delete triggerLayoutsRef.current[tabValue];
    };
  }, []);

  const reportTriggerLayout = useCallback(
    (tabValue: string, layout: TriggerLayout) => {
      // Snap onto the active trigger the moment it is first measured (mount), or
      // when its size changes — never slide in from the origin.
      applyTriggerLayout(tabValue, layout);
      // One trigger changing size moves every trigger after it, and not one of
      // them will say so.
      scheduleRemeasure();
    },
    [applyTriggerLayout, scheduleRemeasure],
  );

  const reportFocused = useCallback(
    (tabValue: string) => {
      selectedValueRef.current = tabValue;
      applySelection(tabValue);
    },
    [applySelection],
  );

  // CONTROLLED path only: the bar owns the underline when `value` is provided.
  // Syncing an imperative animation to a controlled prop is a legitimate effect
  // (external-system sync). On the focus-driven path each trigger reports
  // instead, so this stays out of the way and there is only ever one writer.
  useEffect(() => {
    if (value === undefined) return;
    selectedValueRef.current = value;
    applySelection(value);
  }, [value, applySelection]);

  // Nothing is focused — fade out where it stands. Position is deliberately
  // untouched: see `TabsProps.hasSelection`. Placing this AFTER the controlled
  // effect is what lets a later re-selection snap back rather than travel,
  // because `indicatorPlacedRef` is left alone here.
  useEffect(() => {
    if (hasSelection) return;
    indicatorOpacity.value = withTiming(0, HIGHLIGHT_FADE);
  }, [hasSelection, indicatorOpacity]);

  // Every render of the strip is a render in which its contents may have MOVED:
  // a trigger inserted, removed or reordered, or one re-rendered at a new size.
  // Unconditional on purpose, rather than keyed on a signature of `children` —
  // any such signature has to be built from React keys or child props, both of
  // which the caller controls and neither of which is obliged to change on a
  // reorder. A pass writes nothing when nothing moved, so being wrong in this
  // direction costs a handful of reads and being wrong in the other direction
  // is the bug.
  useEffect(scheduleRemeasure);

  // Web: ONE tab stop for the strip — the selected tab, or the first enabled one
  // when none is — as the ARIA tabs pattern requires (`hooks/roving-focus.ts`).
  // The strip is whichever node carries `role="tablist"`: the scroll view's own
  // node, or the full-width row.
  useRovingTabIndex(
    () =>
      (fullWidth
        ? (stripRef.current as unknown as Element | null)
        : ((scrollRef.current as unknown as { getScrollableNode?: () => Element | null } | null)
            ?.getScrollableNode?.() ?? null)),
    TRIGGER,
    isSelectedTab,
    STRIP,
  );

  useImperativeHandle(
    dragRef,
    (): TabsDragController => ({
      drag(translationX) {
        const current = selectedValueRef.current;
        if (current === undefined) return null;
        // Ordered by measured position, so "the neighbour" means the tab next
        // to it ON SCREEN. Deriving it from child order instead would be wrong
        // the moment a caller reorders or conditionally renders a trigger.
        const ordered = Object.entries(triggerLayoutsRef.current).sort(
          (a, b) => a[1].x - b[1].x,
        );
        const index = ordered.findIndex(([tabValue]) => tabValue === current);
        const from = ordered[index]?.[1];
        if (from === undefined) return null;

        // Opposite the finger: dragging LEFT reveals the NEXT tab, which is to
        // the right, so that is where the underline goes.
        const travel = -translationX;
        const neighbour = ordered[index + (travel > 0 ? 1 : -1)];

        if (neighbour === undefined) {
          // First or last tab. Resist, never commit — the rubber-band is the
          // honest signal that there is nothing in that direction.
          const damped = Math.min(
            Math.abs(travel) * EDGE_RUBBER_BAND_DAMPING,
            EDGE_RUBBER_BAND_MAX,
          );
          dragOffset.value = Math.sign(travel) * damped;
          dragWidthDelta.value = 0;
          return null;
        }

        const [neighbourValue, to] = neighbour;
        const distance = to.x - from.x;
        // Clamped at the neighbour: the underline stops exactly where releasing
        // would leave it, so it never promises travel the commit cannot deliver.
        const progress = Math.min(Math.abs(travel) / Math.abs(distance), 1);
        dragOffset.value = distance * progress;
        dragWidthDelta.value = (to.width - from.width) * progress;
        return progress >= COMMIT_THRESHOLD ? neighbourValue : null;
      },
      release(committed) {
        if (committed === null) {
          dragOffset.value = reducedMotion ? 0 : withTiming(0, slideTiming);
          dragWidthDelta.value = reducedMotion ? 0 : withTiming(0, slideTiming);
          return;
        }
        // Fold, do not zero — see `TabsDragController.release`.
        indicatorX.value += dragOffset.value;
        indicatorWidth.value += dragWidthDelta.value;
        dragOffset.value = 0;
        dragWidthDelta.value = 0;
      },
    }),
    [dragOffset, dragWidthDelta, indicatorX, indicatorWidth, reducedMotion, slideTiming],
  );

  const contextValue = useMemo(
    (): TabsContextValue => ({
      selectedValue: value,
      onValueChange,
      variant: resolvedVariant,
      paint,
      fullWidth,
      registerTrigger,
      reportTriggerLayout,
      reportFocused,
      activation: value === undefined ? 'manual' : 'follow',
    }),
    [
      value,
      onValueChange,
      resolvedVariant,
      paint,
      fullWidth,
      registerTrigger,
      reportTriggerLayout,
      reportFocused,
    ],
  );

  const containerStyle = useMemo(
    (): WebCssStyle => ({
      flexDirection: 'row',
      alignItems: 'center',
      gap: STRIP_GAP,
      // The strip is `w-full`: the baseline runs the container's whole
      // width even when the triggers do not fill it. As a scroll view's content
      // this is a floor, so an overflowing strip still scrolls.
      flexGrow: 1,
      // `border-b border-separator-border` — underline only; the pill
      // strips carry no chrome of their own.
      ...(isUnderline ? { borderBottomWidth: 1, borderBottomColor: paint.separator } : null),
    }),
    [isUnderline, paint.separator],
  );

  // Web only: `role="tablist"` and its name. On native the strip stays a plain
  // container — a named native View would become ONE accessibility element
  // and swallow its tabs on iOS.
  const stripA11y: Record<string, unknown> = IS_WEB
    ? { role: 'tablist', 'aria-label': label, dataSet: { bloomTabsStrip: '' } }
    : {};

  // The underline sits OVER the baseline: it is `bottom-0` of a wrapper whose
  // child carries the border. An absolute child is placed inside the border,
  // so it is pulled down by the baseline's own width — read from the caller's
  // `style` too, so a strip that zeroes the border (a published consumer
  // does) does not get an underline hanging 1px below the strip.
  const baselineWidth = isUnderline
    ? (StyleSheet.flatten(style)?.borderBottomWidth ?? 1)
    : 0;

  // Deps: every shared value the mapper READS is listed. On web WITHOUT the
  // react-native-worklets babel plugin — the production reality for Bloom's
  // Vite consumers — reanimated cannot auto-detect a worklet's reads and drives
  // the mapper off this array instead: omit one and the mapper runs ONCE and
  // freezes at the first frame while the shared value keeps animating
  // underneath, with no error anywhere. Native (plugin present) auto-tracks and
  // ignores the extras, so listing them is correct on both platforms. Same rule
  // as `TabBarBase` and `BottomSheetBase`. Do NOT strip these.
  const indicatorStyle = useAnimatedStyle(
    () => ({
      // The drag deltas ADD to the settled values rather than replacing them,
      // which is what lets a release fold them into the base with no jump.
      width: Math.max(indicatorWidth.value + dragWidthDelta.value, 0),
      opacity: indicatorOpacity.value,
      transform: [{ translateX: indicatorX.value + dragOffset.value }],
    }),
    [indicatorWidth, dragWidthDelta, indicatorOpacity, indicatorX, dragOffset],
  );

  // The underline is a sibling of the triggers INSIDE the scrollable content,
  // so the two share one coordinate space: a trigger's `onLayout` x is already
  // relative to the container the underline is absolutely positioned in. That
  // is why nothing here subtracts a scroll offset — an underline parked outside
  // the scroller would have to, and would lag by a frame on every scroll event.
  const indicator = (
    <Animated.View
      pointerEvents="none"
      testID={testID ? `${testID}-indicator` : undefined}
      style={[
        isUnderline
          ? {
              position: 'absolute',
              left: 0,
              bottom: -baselineWidth,
              height: 2,
              backgroundColor: paint.underline,
            }
          : {
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              borderRadius: borderRadius.full,
              backgroundColor: paint.thumb,
            },
        indicatorStyle,
      ]}
    />
  );

  return (
    <TabsContext.Provider value={contextValue}>
      {fullWidth ? (
        <View ref={stripRef} {...stripA11y} style={[containerStyle, style]} testID={testID}>
          {isUnderline ? null : indicator}
          {children}
          {isUnderline ? indicator : null}
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          {...stripA11y}
          horizontal
          // A tab strip owns its intrinsic cross-axis height. RN ScrollView's
          // default flexGrow: 1 otherwise consumes the list's remaining space.
          style={{ flexGrow: 0, flexShrink: 0 }}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[containerStyle, style]}
          onLayout={(e) => {
            viewportWidthRef.current = e.nativeEvent.layout.width;
          }}
          testID={testID}
        >
          {isUnderline ? null : indicator}
          {children}
          {isUnderline ? indicator : null}
        </ScrollView>
      )}
    </TabsContext.Provider>
  );
});

const TabComponent: React.FC<TabsTriggerProps> = ({
  value,
  label,
  leading,
  leadingIcon: LeadingIcon,
  count,
  isFocused,
  disabled = false,
  onPress: onPressProp,
  style,
  textStyle,
}) => {
  const {
    selectedValue,
    onValueChange,
    variant,
    paint,
    fullWidth,
    registerTrigger,
    reportTriggerLayout,
    reportFocused,
    activation,
  } = useTabsContext('TabsTrigger');
  // The two paths meet here: an explicit `isFocused` (router adapter) wins;
  // otherwise selection comes from the bar's controlled `value`.
  const isSelected = isFocused ?? value === selectedValue;
  const { state: hovered, onIn: onHoverIn, onOut: onHoverOut } = useInteractionState();
  // Native has no hover, so a held press borrows the hover paint — the only
  // other state defined. No press scale.
  const { state: pressed, onIn: onPressIn, onOut: onPressOut } = useInteractionState();
  const resolvedCount = count ?? 0;
  const showCount = resolvedCount > 0;
  const geometry = GEOMETRY[variant];
  const isUnderline = variant === 'underline';

  // The trigger's own host view. It stays here rather than in the strip because
  // the strip has no way to reach a child it did not create — it receives them
  // as `children` — and because a trigger is the only thing that knows its own
  // value, which is what the geometry has to be keyed by.
  const nodeRef = useRef<View | null>(null);
  const measureSelf = useCallback<TriggerMeasure>((report) => {
    nodeRef.current?.measure((x, _y, width) => {
      report({ x, width });
    });
  }, []);

  // Registration IS the insertion/removal signal the strip acts on, so it must
  // outlive nothing: the cleanup drops both the measure hook and the geometry.
  useEffect(
    () => registerTrigger(value, measureSelf),
    [registerTrigger, value, measureSelf],
  );

  // FOCUS-DRIVEN path only. This covers programmatic navigation too — a deep
  // link, a browser Back, a back gesture — because nothing here asks HOW the
  // change happened: the trigger simply re-renders focused and the underline
  // follows. On the controlled path the bar drives the underline instead, so
  // this stays out of the way to avoid two writers on one shared value.
  useEffect(() => {
    if (isFocused !== true) return;
    reportFocused(value);
  }, [isFocused, value, reportFocused]);

  const handlePress = useCallback(() => {
    if (disabled) return;
    onPressProp?.();
    // On the focus-driven path navigation is the caller's job (the router
    // adapter's trigger performs it), so reporting a selection here as well
    // would fight the router for the same underline.
    if (isFocused === undefined) onValueChange?.(value);
  }, [value, disabled, onValueChange, onPressProp, isFocused]);

  // Web keyboard (ARIA tabs): Left/Right move between tabs with wrap-around,
  // Home/End jump to the ends, disabled tabs are skipped, and Space selects —
  // react-native-web presses a `tab` on Enter only. Enter stays with its own
  // press handling.
  const webKeyboard = useMemo(
    () =>
      IS_WEB
        ? {
            onKeyDown: (event: { key: string; currentTarget: unknown; preventDefault: () => void }) => {
              handleRovingKeyDown(event, {
                selector: TRIGGER,
                owner: STRIP,
                orientation: 'horizontal',
                homeEnd: true,
                activate: activation,
              });
            },
          }
        : {},
    [activation],
  );

  const labelColor = isSelected ? paint.selectedLabel : paint.idleLabel;
  const iconColor = isSelected ? paint.selectedIcon : paint.idleIcon;

  const triggerStyle = useMemo(
    (): WebCssStyle => ({
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingLeft: geometry.paddingHorizontal,
      paddingRight: geometry.paddingHorizontal,
      paddingTop: geometry.paddingVertical,
      paddingBottom: geometry.paddingVertical,
      gap: geometry.gap,
      borderRadius: geometry.radius,
      // `ring-2`, no offset — read by the adopted sheet's `:focus-visible` rule.
      '--bloom-tabs-ring': paint.ring,
    }),
    [geometry, paint.ring],
  );

  const labelTextStyle = useMemo(
    (): TextStyle => ({
      // Selected underline tabs go medium, idle ones regular; pill labels are
      // medium in both states.
      ...TYPE_SCALE[isUnderline && !isSelected ? 'body-regular' : 'body-medium'],
      color: labelColor,
    }),
    [isUnderline, isSelected, labelColor],
  );

  const renderedIcon = LeadingIcon ? (
    <View {...webDataSet({ bloomTabsIcon: '' })} style={{ flexShrink: 0 }}>
      <LeadingIcon width={geometry.icon} height={geometry.icon} fill={iconColor} />
    </View>
  ) : (
    (leading ?? null)
  );

  const showHoverLayer = !isUnderline && !isSelected && !disabled;

  return (
    <View
      ref={nodeRef}
      onLayout={(e) => {
        const { x, width } = e.nativeEvent.layout;
        reportTriggerLayout(value, { x, width });
      }}
      style={fullWidth ? { flex: 1 } : undefined}
    >
      <Pressable
        {...webDataSet({ bloomTabsTrigger: variant })}
        {...webKeyboard}
        style={[
          triggerStyle,
          fullWidth && { flex: 1 },
          disabled && { opacity: 0.5 },
          style,
        ]}
        onPress={handlePress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onHoverIn={onHoverIn}
        onHoverOut={onHoverOut}
        disabled={disabled}
        accessibilityRole="tab"
        accessibilityLabel={showCount ? `${label}, ${resolvedCount}` : label}
        // `aria-selected`, and NOT a web-only spelling of `accessibilityState`.
        // react-native-web's `createDOMProps` reads `aria-selected` (or the
        // deprecated `accessibilitySelected`) and does not look at
        // `accessibilityState` at all, so a strip that set only the latter
        // announced no selection on web at all — every tab equally current.
        // React Native's own `Pressable` folds `aria-selected` back into
        // `accessibilityState.selected`, so this one prop serves both platforms
        // and there is no second place for the answer to disagree. `disabled`
        // needs no counterpart: both Pressables already derive that state from
        // the `disabled` prop above.
        aria-selected={isSelected}
      >
        {showHoverLayer ? (
          <View
            pointerEvents="none"
            {...webDataSet({ bloomTabsHover: '' })}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              borderRadius: geometry.radius,
              backgroundColor: paint.hover,
              opacity: hovered || pressed ? 1 : 0,
            }}
          />
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: geometry.labelGap }}>
          {renderedIcon}
          <Text
            {...webDataSet({ bloomTabsLabel: '' })}
            numberOfLines={1}
            style={[labelTextStyle, textStyle]}
          >
            {label}
          </Text>
        </View>
        {showCount ? (
          <View
            style={{
              borderRadius: 4,
              paddingLeft: 4,
              paddingRight: 4,
              paddingTop: 1,
              paddingBottom: 1,
              backgroundColor: isSelected
                ? paint.countSelectedBackground
                : paint.countIdleBackground,
              opacity: isSelected ? 1 : 0.5,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                ...TYPE_SCALE['caption-1-medium'],
                color: isSelected ? paint.countSelectedForeground : paint.countIdleForeground,
              }}
            >
              {formatCount(resolvedCount)}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
};

const TabPanelComponent: React.FC<TabsContentProps> = ({ value, children, style }) => {
  const { selectedValue } = useTabsContext('TabsContent');
  if (value !== selectedValue) return null;

  return <View style={style}>{children}</View>;
};

export const Tabs = memo(TabsBarComponent);
Tabs.displayName = 'Tabs';

export const TabsTrigger = memo(TabComponent);
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = memo(TabPanelComponent);
TabsContent.displayName = 'TabsContent';

```

## node_modules/@oxy.so/bloom/src/typography/Typography.tsx
```tsx
import React, { memo } from 'react';
import {
  type TextProps as RNTextProps,
  Platform,
  StyleSheet,
  type TextStyle,
  useWindowDimensions,
  View,
} from 'react-native';

import { useTheme } from '../theme/use-theme';
import { fontFamilies } from '../fonts/tokens';
import { BREAKPOINTS } from '../styles/breakpoints';
import { space } from '../styles/tokens';
import { mergeTypographyStyle, typographyDefaultsWhenNoClassName } from './defaults';
import { TYPE_SCALE } from './scale';
import { StyledText } from '../styles/styled-primitives';
import type { BlockquoteProps, TextProps } from './types';

/**
 * Platform-aware font-family value. On web we resolve to the CSS custom
 * property set by `applyFontFaces` so consumer apps can re-skin Bloom by
 * overriding `--bloom-font-*` at any subtree. On native we use the literal
 * family name registered by `expo-font`'s `useFonts(FONT_ASSETS)`.
 */
function fontFamilyStyle(
  kind: 'display' | 'sans' | 'mono',
): { fontFamily: string } {
  if (Platform.OS === 'web') {
    return { fontFamily: `var(--bloom-font-${kind})` };
  }
  if (kind === 'mono') return { fontFamily: 'JetBrains Mono' };
  // On RN the literal family name is the only thing that matters; the .ttf is
  // registered via `useFonts(FONT_ASSETS)` in `FontLoader.native.tsx`. `sans`
  // is Inter (the UI face); `display` keeps BlomusModernus.
  if (kind === 'display') return { fontFamily: 'BlomusModernus' };
  return { fontFamily: 'Inter' };
}

const SANS_FONT_FAMILY = fontFamilyStyle('sans');
const DISPLAY_FONT_FAMILY = fontFamilyStyle('display');

const DEFAULT_TEXT_TYPOGRAPHY: TextStyle = {
  fontSize: 13,
};

/**
 * Base text component with theme-aware default color and the Bloom sans
 * font family applied. NativeWind `className` utilities (text-*, font-*,
 * leading-*, text-foreground, …) override defaults when provided.
 */
const TextComponent = function Text({ children, style, className, variant, ...rest }: TextProps) {
  const { colors } = useTheme();
  const trimmedClassName = className?.trim() ? className : undefined;

  return (
    <StyledText
      {...rest}
      {...(trimmedClassName ? { className: trimmedClassName } : {})}
      style={mergeTypographyStyle(
        trimmedClassName,
        { ...(variant ? TYPE_SCALE[variant] : DEFAULT_TEXT_TYPOGRAPHY), color: colors.text },
        SANS_FONT_FAMILY,
        style,
      )}
    >
      {children}
    </StyledText>
  );
};

export const Text = memo(TextComponent);
Text.displayName = 'Text';

/**
 * The heading ramp, in react-native-reusables' own numbers.
 *
 * Upstream's `h1`–`h4` are `text-4xl font-extrabold tracking-tight`,
 * `text-3xl font-semibold tracking-tight`, `text-2xl …` and `text-xl …` — a
 * ramp Bloom's headings did not have AT ALL: every level rendered at the base
 * `Text` size, so an `<H1>` and a `<Span>` were the same 13px apart from their
 * weight. `tracking-tight` is −0.025em, resolved against each level's own size.
 *
 * `h5`/`h6` have no upstream counterpart; they continue the ramp at `text-lg`
 * and `text-base` with `h4`'s weight.
 *
 * `font-extrabold` on `h1` and `font-semibold` below it are carried across.
 * The FAMILY is not: upstream sets everything in one sans face, where a Bloom
 * heading is set in the display family — the same layer as the colour roles,
 * and Bloom's own.
 */
const HEADING_SCALE: Record<number, TextStyle> = {
  1: { fontSize: 36, lineHeight: 40, fontWeight: '800', letterSpacing: 36 * -0.025 },
  2: { fontSize: 30, lineHeight: 36, fontWeight: '600', letterSpacing: 30 * -0.025 },
  3: { fontSize: 24, lineHeight: 32, fontWeight: '600', letterSpacing: 24 * -0.025 },
  4: { fontSize: 20, lineHeight: 28, fontWeight: '600', letterSpacing: 20 * -0.025 },
  5: { fontSize: 18, lineHeight: 28, fontWeight: '600', letterSpacing: 18 * -0.025 },
  6: { fontSize: 16, lineHeight: 24, fontWeight: '600', letterSpacing: 16 * -0.025 },
};

/** `text-center` — upstream centres `h1`, and only `h1`. */
const H1_ALIGNMENT: TextStyle = { textAlign: 'center' };

/** `border-border border-b pb-2` — upstream rules `h2` off from what follows. */
const H2_RULE: TextStyle = { borderBottomWidth: 1, paddingBottom: 8 };

function createHeadingElement({ level }: { level: number }): React.FC<TextProps> {
  return function HeadingElement({ style, className, ...rest }: TextProps) {
    const { colors } = useTheme();
    const extraProps: Record<string, unknown> =
      Platform.OS === 'web'
        ? { role: 'heading', 'aria-level': level }
        : {};

    // Only the FAMILY survives a caller's `className`: react-native-css merges
    // utilities into `style` first, so keeping `fontSize`/`fontWeight` here
    // would silently beat a caller's `text-2xl`.
    const headingBase = className?.trim()
      ? DISPLAY_FONT_FAMILY
      : {
          ...DISPLAY_FONT_FAMILY,
          ...HEADING_SCALE[level],
          ...(level === 1 ? H1_ALIGNMENT : null),
          ...(level === 2 ? { ...H2_RULE, borderBottomColor: colors.border } : null),
        };

    return (
      <Text
        {...extraProps}
        {...rest}
        className={className}
        style={[headingBase, style]}
      />
    );
  };
}

export const H1 = createHeadingElement({ level: 1 });
H1.displayName = 'H1';
export const H2 = createHeadingElement({ level: 2 });
H2.displayName = 'H2';
export const H3 = createHeadingElement({ level: 3 });
H3.displayName = 'H3';
export const H4 = createHeadingElement({ level: 4 });
H4.displayName = 'H4';
export const H5 = createHeadingElement({ level: 5 });
H5.displayName = 'H5';
export const H6 = createHeadingElement({ level: 6 });
H6.displayName = 'H6';

/** `mt-3 leading-7 sm:mt-6`, over the base `text-base`. */
const DEFAULT_PARAGRAPH_TYPOGRAPHY: TextStyle = {
  fontSize: 16,
  lineHeight: 28,
};

export function P({ style, className, ...rest }: TextProps) {
  const { width } = useWindowDimensions();
  const extraProps: Record<string, unknown> =
    Platform.OS === 'web' ? { role: 'paragraph' } : {};
  const paragraphDefaults = typographyDefaultsWhenNoClassName(className, {
    ...DEFAULT_PARAGRAPH_TYPOGRAPHY,
    marginTop: width >= BREAKPOINTS.sm ? space._2xl : space.md,
  });
  return (
    <Text
      {...extraProps}
      {...rest}
      className={className}
      style={[paragraphDefaults, style]}
    />
  );
}
P.displayName = 'P';

export { Text as Span };

// ---------------------------------------------------------------------------
//  Semantic prose variants
//
//  shadcn/react-native-reusables express these as `variant` on ONE `Text`
//  (`lead`, `large`, `small`, `muted`, `blockquote`). Bloom's typography is flat
//  components (`H1`, `P`, `Span`) and stays that way: a flat component is what
//  `H1`–`H6` already are, and a `variant` prop beside them would be two ways to
//  ask for a heading. RNR's `code` variant is deliberately NOT ported — Bloom's
//  `code/` family already owns that, and a second spelling is the ambiguity
//  Bloom removes rather than adds.
//
//  Every one of these applies its defaults through
//  `typographyDefaultsWhenNoClassName`, for the reason that helper exists:
//  react-native-css merges utilities into `style` FIRST, so an inline default
//  repeating `fontSize`/`color` would silently beat the caller's `text-lg` or
//  `text-primary`.
// ---------------------------------------------------------------------------

/** `text-muted-foreground text-xl` — 20/28. */
const LEAD_TYPOGRAPHY: TextStyle = {
  fontSize: 20,
  lineHeight: 28,
};

/** An intro paragraph — larger than body text and set in the secondary colour. */
export function Lead({ style, className, ...rest }: TextProps) {
  const { colors } = useTheme();
  const defaults = typographyDefaultsWhenNoClassName(className, {
    ...LEAD_TYPOGRAPHY,
    color: colors.textSecondary,
  });
  return <Text {...rest} className={className} style={[defaults, style]} />;
}
Lead.displayName = 'Lead';

/** `text-lg font-semibold` — 18/28. */
const LARGE_TYPOGRAPHY: TextStyle = {
  fontSize: 18,
  lineHeight: 28,
  fontWeight: '600',
};

/** Emphasised body text — a form section's opening line, a callout's first row. */
export function Large({ style, className, ...rest }: TextProps) {
  const defaults = typographyDefaultsWhenNoClassName(className, LARGE_TYPOGRAPHY);
  return <Text {...rest} className={className} style={[defaults, style]} />;
}
Large.displayName = 'Large';

/** `text-sm font-medium leading-none` — 14, and `leading-none` is exactly 1×. */
const SMALL_TYPOGRAPHY: TextStyle = {
  fontSize: 14,
  lineHeight: 14,
  fontWeight: '500',
};

/** A dense label — form hints, table headers, metadata rows. */
export function Small({ style, className, ...rest }: TextProps) {
  const defaults = typographyDefaultsWhenNoClassName(className, SMALL_TYPOGRAPHY);
  return <Text {...rest} className={className} style={[defaults, style]} />;
}
Small.displayName = 'Small';

/** `text-muted-foreground text-sm` — 14/20. */
const MUTED_TYPOGRAPHY: TextStyle = {
  fontSize: 14,
  lineHeight: 20,
};

/** De-emphasised supporting text. */
export function Muted({ style, className, ...rest }: TextProps) {
  const { colors } = useTheme();
  const defaults = typographyDefaultsWhenNoClassName(className, {
    ...MUTED_TYPOGRAPHY,
    color: colors.textSecondary,
  });
  return <Text {...rest} className={className} style={[defaults, style]} />;
}
Muted.displayName = 'Muted';

/**
 * A quotation, with the rule down its left edge.
 *
 * The one variant that is NOT a bare `Text`, and the one that takes no
 * `className`. React Native ignores border styles on `Text` (Android renders a
 * TextView, iOS an NSAttributedString — neither draws a left rule), so the rule
 * has to be a `View`. That makes the node the parent lays out a `View` while the
 * utilities a caller would write (`text-lg`, `text-primary`) belong on the
 * `Text` inside it — the exact split that makes `className` land on the wrong
 * node and fail silently. So it is not offered: `style` addresses the container,
 * `textStyle` the quotation, and a caller who wants utilities composes a `View`
 * and a `Text` directly.
 */
export function Blockquote({ children, style, textStyle, testID }: BlockquoteProps) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= BREAKPOINTS.sm;
  const extraProps: Record<string, unknown> =
    Platform.OS === 'web' ? { role: 'blockquote' } : {};

  return (
    <View
      {...extraProps}
      testID={testID}
      style={[
        styles.blockquote,
        // `mt-4 sm:mt-6` and `pl-3 sm:pl-6` — a leading margin only, never a
        // trailing one, so a quotation sits against the paragraph it follows.
        { marginTop: wide ? space._2xl : space.lg, paddingLeft: wide ? space._2xl : space.md },
        { borderLeftColor: colors.border },
        style,
      ]}>
      <Text style={[styles.blockquoteText, { color: colors.textSecondary }, textStyle]}>
        {children}
      </Text>
    </View>
  );
}
Blockquote.displayName = 'Blockquote';

const styles = StyleSheet.create({
  // `border-l-2 italic` (the insets are applied at the call site, where the
  // breakpoint is read).
  blockquote: {
    borderLeftWidth: 2,
  },
  blockquoteText: {
    fontSize: 16,
    lineHeight: 24,
    fontStyle: 'italic',
  },
});

export { fontFamilies };

```
