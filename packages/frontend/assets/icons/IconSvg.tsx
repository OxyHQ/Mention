import React, { Children, cloneElement, isValidElement } from 'react';
import Svg, { type SvgProps } from 'react-native-svg';
import { useCurrentColor } from '@/hooks/useCurrentColor';

/**
 * Shared SVG root for every icon in `assets/icons/*`.
 *
 * Icons author their paths with `fill="currentColor"` / `stroke="currentColor"`
 * (or a `color` prop that defaults to `'currentColor'`). On web that keyword
 * inherits the nearest `text-*` ancestor's color via the CSS cascade. React
 * Native has no cascade, so `currentColor` never resolves and icons render
 * black regardless of their parent's `text-primary` / `text-foreground` class.
 *
 * `IconSvg` resolves `currentColor` exactly once — through `useCurrentColor()`,
 * which on web returns the literal `'currentColor'` (cascade untouched) and on
 * native returns the inherited `--__rn-css-color` variable (falling back to the
 * theme foreground). It then recursively rewrites any `currentColor` value on
 * its SVG children to that resolved color, so a single shared mechanism colors
 * every icon on native without a per-call-site color prop or 55 hardcoded
 * colors. Web output is byte-for-byte identical to before.
 */

const CURRENT_COLOR = 'currentColor';
const COLOR_PROPS = ['fill', 'stroke', 'color'] as const;

type SvgChildProps = {
  fill?: unknown;
  stroke?: unknown;
  color?: unknown;
  children?: React.ReactNode;
};

function resolveCurrentColor(node: React.ReactNode, resolved: string): React.ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement<SvgChildProps>(child)) {
      return child;
    }

    const overrides: Partial<SvgChildProps> = {};
    for (const prop of COLOR_PROPS) {
      if (child.props[prop] === CURRENT_COLOR) {
        overrides[prop] = resolved;
      }
    }

    const nextChildren = child.props.children
      ? resolveCurrentColor(child.props.children, resolved)
      : child.props.children;

    if (Object.keys(overrides).length === 0 && nextChildren === child.props.children) {
      return child;
    }

    return cloneElement(child, overrides, nextChildren);
  });
}

export function IconSvg({ children, ...props }: SvgProps) {
  const currentColor = useCurrentColor();
  // On web `currentColor` stays `'currentColor'`, so nothing is rewritten and
  // the cascade keeps working. On native it's a concrete color.
  const content = currentColor === CURRENT_COLOR
    ? children
    : resolveCurrentColor(children, currentColor);

  return <Svg {...props}>{content}</Svg>;
}
