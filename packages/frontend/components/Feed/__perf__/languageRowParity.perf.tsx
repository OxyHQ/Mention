import type React from 'react';
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { useTheme } from '@oxy.so/bloom/theme';
import { VideoPlaybackProvider, VideoViewabilityProvider } from '@oxy.so/bloom/video-playback';

import { PostVisibility } from '@mention/shared-types';
import { appI18n, initializeI18n } from '@/lib/i18n';
import PostItem from '../PostItem';
import LanguagePostItem from '../LanguagePostItem';
import type { PostItemProps } from '../postItemProps';
import { ROW_KINDS, makeRow } from './fixtures';

/**
 * The Bloom-language row against the JSX row, node by node, under the real
 * Bloom provider (the harness environment: real components, real styles).
 *
 * Every host node the two rows commit is compared on its type, its text, its
 * accessibility and press props, and its RESOLVED style: the JSX row's class
 * names resolve through the same NativeWind pipeline the app uses, the
 * language row's tokens through Bloom's tables. Logical and physical insets
 * are compared as the LTR box they draw. The one known structural difference
 * is listed and asserted, not skipped.
 */

const NO_VIEWABLE_KEYS: ReadonlySet<string> = new Set();

/** The theme the rows render under, for the colour classes below. */
let themeColors: Record<string, string> = {};
function ColorProbe() {
  themeColors = useTheme().colors as unknown as Record<string, string>;
  return null;
}

/**
 * The class names the JSX row's own nodes use, as the style NativeWind gives
 * them on native (Tailwind v4 values; `leading-tight` is 1.25 times the size).
 * Both trees go through it, so an embedded node (the same JSX on both sides)
 * compares as itself; a class not listed fails the comparison rather than
 * passing unread.
 */
function classStyle(className: string, fontSize: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of className.split(/\s+/).filter(Boolean)) {
    switch (name) {
      case 'group':
      case 'web:whitespace-nowrap':
        break;
      case 'border-border':
        out.borderColor = themeColors.border;
        break;
      case 'flex-row':
        out.flexDirection = 'row';
        break;
      case 'items-start':
        out.alignItems = 'flex-start';
        break;
      case 'items-end':
        out.alignItems = 'flex-end';
        break;
      case 'items-center':
        out.alignItems = 'center';
        break;
      case 'justify-between':
        out.justifyContent = 'space-between';
        break;
      case 'flex-1':
        out.flex = 1;
        break;
      case 'min-w-0':
        out.minWidth = 0;
        break;
      case 'flex-shrink':
      case 'shrink':
        out.flexShrink = 1;
        break;
      case 'text-muted-foreground':
        out.color = themeColors.textSecondary;
        break;
      case 'text-foreground':
        out.color = themeColors.text;
        break;
      case 'text-[13px]':
        out.fontSize = 13;
        break;
      case 'text-[15px]':
        out.fontSize = 15;
        break;
      case 'font-semibold':
        out.fontWeight = '600';
        break;
      case 'leading-tight':
        out.lineHeight = 1.25 * (Number(out.fontSize ?? fontSize) || 0);
        break;
      case '-ml-4':
        out.marginLeft = -16;
        break;
      case 'mr-[3px]':
        out.marginRight = 3;
        break;
      default:
        out[`class:${name}`] = true;
    }
  }
  return out;
}

function mount(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <BloomProvider fonts={false} haptics={false} defaultMode="light">
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={appI18n}>
            <VideoPlaybackProvider>
              <VideoViewabilityProvider viewableKeys={NO_VIEWABLE_KEYS}>
                <ColorProbe />
                {element}
              </VideoViewabilityProvider>
            </VideoPlaybackProvider>
          </I18nextProvider>
        </QueryClientProvider>
      </BloomProvider>,
    );
  });
  return renderer;
}

const PHYSICAL: Record<string, string> = {
  paddingStart: 'paddingLeft',
  paddingEnd: 'paddingRight',
  marginStart: 'marginLeft',
  marginEnd: 'marginRight',
  borderStartWidth: 'borderLeftWidth',
  borderEndWidth: 'borderRightWidth',
};

/** A style as the box it draws in LTR: flattened, shorthands expanded, logical edges physical. */
function box(style: unknown): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const visit = (s: unknown) => {
    if (Array.isArray(s)) s.forEach(visit);
    else if (s && typeof s === 'object') Object.assign(flat, s);
  };
  visit(style);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (value === undefined) continue;
    if (key === 'paddingHorizontal' || key === 'marginHorizontal') {
      const p = key.replace('Horizontal', '');
      out[`${p}Left`] = value;
      out[`${p}Right`] = value;
    } else if (key === 'paddingVertical' || key === 'marginVertical') {
      const p = key.replace('Vertical', '');
      out[`${p}Top`] = value;
      out[`${p}Bottom`] = value;
    } else out[PHYSICAL[key] ?? key] = value;
  }
  // Zero insets and widths draw nothing, whichever way they are spelled.
  for (const key of Object.keys(out)) {
    if (/^(padding|margin)/.test(key) && out[key] === 0) delete out[key];
    if (/Width$/.test(key) && key.startsWith('border') && out[key] === 0) delete out[key];
  }
  // A border paints its colour only on the sides that have a width.
  const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
  const width = (side: string) => out[`border${side}Width`] ?? out.borderWidth;
  const color = (side: string) => out[`border${side}Color`] ?? out.borderColor;
  const painted: Record<string, unknown> = {};
  for (const side of sides) {
    if (width(side) !== undefined) {
      painted[`border${side}Width`] = width(side);
      painted[`border${side}Color`] = color(side);
    }
  }
  for (const key of Object.keys(out))
    if (/^border(Top|Right|Bottom|Left)?(Width|Color)$/.test(key)) delete out[key];
  return { ...out, ...painted };
}

const COMPARED_PROPS = [
  'accessibilityLabel',
  'accessibilityRole',
  'accessibilityState',
  'role',
  'testID',
  'numberOfLines',
  'focusable',
  'pointerEvents',
] as const;

interface Flat {
  path: string;
  type: string;
  props: Record<string, unknown>;
  style: Record<string, unknown>;
  text: string;
  pressable: boolean;
}

function flatten(node: ReactTestRendererJSON | ReactTestRendererJSON[] | null, path = ''): Flat[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap((child, i) => flatten(child, `${path}${i}.`));
  const props: Record<string, unknown> = {};
  for (const key of COMPARED_PROPS) if (node.props[key] !== undefined) props[key] = node.props[key];
  const text = (node.children ?? []).filter((c) => typeof c === 'string').join('');
  const inline = box(node.props.style);
  const classes =
    typeof node.props.className === 'string'
      ? classStyle(node.props.className, inline.fontSize)
      : {};
  const here: Flat = {
    path,
    type: node.type,
    props,
    style: box([classes, inline]),
    text,
    pressable:
      typeof node.props.onClick === 'function' ||
      typeof node.props.onPress === 'function' ||
      typeof node.props.onResponderRelease === 'function',
  };
  const children = (node.children ?? []).filter(
    (c): c is ReactTestRendererJSON => typeof c !== 'string',
  );
  return [here, ...children.flatMap((child, i) => flatten(child, `${path}${i}/`))];
}

/**
 * The one geometry-preserving difference: the JSX row spaces the avatar from
 * the content column with the avatar's `marginRight: 12`; the language row
 * has no margins, so the content column takes it as `paddingLeft: 12`. Same
 * box positions, one fewer wrapper. Applied to the JSX tree, and asserted to
 * have applied.
 */
function avatarGapAsContentPadding(tree: Flat[]): Flat[] {
  const avatar = tree.findIndex((node) => node.style.marginRight === 12 && node.style.width === 36);
  const column = tree.findIndex(
    (node, i) => i > avatar && node.style.flex === 1 && node.style.minWidth === 0,
  );
  expect(avatar).toBeGreaterThanOrEqual(0);
  expect(column).toBeGreaterThan(avatar);
  return tree.map((node, i) => {
    if (i === avatar) {
      const { marginRight: _gap, ...style } = node.style;
      return { ...node, style };
    }
    if (i === column) return { ...node, style: { ...node.style, paddingLeft: 12 } };
    return node;
  });
}

function rowTree(Row: React.ComponentType<PostItemProps>, props: PostItemProps): Flat[] {
  const renderer = mount(<Row {...props} />);
  const tree = flatten(renderer.toJSON());
  act(() => renderer.unmount());
  return tree.map(({ path: _path, ...rest }) => rest as Flat);
}

beforeAll(async () => {
  await initializeI18n();
});

/**
 * Both rows, compared after the named re-spellings: the avatar gap (above);
 * the context-row offset, which the JSX row writes as `marginTop: 22 × rows`
 * on the avatar and the ⋯ button and the language row as a column per side
 * under one 18-high spacer per row (4 apart); and the context glyph's 3px,
 * margin in JSX, padding in the language; and the face: every language text
 * names Bloom's (Inter here), as Bloom's Text does, where a className Text in
 * the JSX row names none and so draws the system font (Bloom's FontLoader made
 * Inter the default through `Text.defaultProps`, which React 19 no longer
 * applies to function components). Returns how many context rows offset the
 * header, so a case can assert it exercised them.
 */
/** Bloom Text's face for everything but the title families (none of which the row uses). */
const BLOOM_FACE = 'Inter';

function compareRows(
  props: PostItemProps,
  jsxProps: Partial<PostItemProps> & { style?: object } = {},
): { rows: number; language: Flat[] } {
  const jsx = avatarGapAsContentPadding(rowTree(PostItem, { ...props, ...jsxProps }));
  const language = rowTree(LanguagePostItem, props);
  const offset = jsx.find(
    (node) =>
      typeof node.style.marginTop === 'number' &&
      (node.style.marginTop as number) % 22 === 0 &&
      (node.style.marginTop as number) > 0,
  );
  const rows = offset ? (offset.style.marginTop as number) / 22 : 0;
  const isColumn = (node: Flat) => Object.keys(node.style).join() === 'gap' && node.style.gap === 4;
  const isSpacer = (node: Flat) => node.style.flex === 1 && node.style.height === 18;
  expect(language.filter(isColumn)).toHaveLength(rows > 0 ? 2 : 0);
  expect(language.filter(isSpacer)).toHaveLength(rows * 2);
  const drawn = language.filter((node) => !isColumn(node) && !isSpacer(node));
  // Every text the language draws names Bloom's face; a text with no family is
  // the app's own JSX, embedded in the row as it is in the JSX row.
  const faces = new Set(
    drawn.filter((node) => node.type === 'Text').map((node) => node.style.fontFamily),
  );
  expect(faces).toEqual(new Set([BLOOM_FACE, undefined]));
  const rewritten = jsx.map((node, i) => {
    if (
      node.type === 'Text' &&
      node.style.fontFamily === undefined &&
      drawn[i]?.type === 'Text' &&
      drawn[i]?.style.fontFamily === BLOOM_FACE
    ) {
      return { ...node, style: { ...node.style, fontFamily: BLOOM_FACE } };
    }
    if (node.style.marginLeft === -16 && node.style.marginRight === 3) {
      const { marginRight: _gap, ...style } = node.style;
      return { ...node, style: { ...style, paddingRight: 3 } };
    }
    if (rows > 0 && node.style.marginTop === rows * 22) {
      const { marginTop: _offset, ...style } = node.style;
      return { ...node, style };
    }
    return node;
  });
  expect(drawn).toEqual(rewritten);
  return { rows, language };
}

describe('the language row draws what the JSX row draws', () => {
  it.each(ROW_KINDS.filter((kind) => kind !== 'repost'))('%s', (kind) => {
    const post = makeRow(kind, 'parity');
    expect(compareRows({ post, feedDescriptor: 'parity' }).rows).toBe(0);
  });

  it('repost, with its "Reposted by" row', () => {
    const post = makeRow('repost', 'parity');
    const props = {
      post: post.boost?.originalPost ?? post,
      repostedBy: post.boost?.actor,
      feedDescriptor: 'parity',
    } as PostItemProps;
    expect(compareRows(props).rows).toBe(1);
  });

  it('pinned and reposted: two context rows', () => {
    const post = makeRow('repost', 'parity');
    const props = {
      post: post.boost?.originalPost ?? post,
      repostedBy: post.boost?.actor,
      showPinned: true,
    } as PostItemProps;
    expect(compareRows(props).rows).toBe(2);
  });

  it('a thread: parent, middle and last rows with their lines', () => {
    const post = makeRow('text', 'thread');
    const lines = (tree: Flat[]) =>
      tree.filter((node) => node.style.position === 'absolute' && node.style.width === 2).length;
    const parent = compareRows({
      post,
      isThreadParent: true,
      sliceKey: 's',
      threadOpenId: 'p',
      isThread: true,
    });
    expect(lines(parent.language)).toBe(1);
    compareRows({ post, isThreadChild: true, isThreadParent: true, sliceKey: 's', isThread: true });
    compareRows({
      post,
      isThreadChild: true,
      isThreadLastChild: true,
      sliceKey: 's',
      isThread: true,
    });
  });

  it('a reply branch: elbow, and no separator', () => {
    const post = makeRow('text', 'branch');
    compareRows(
      { post, replyBranch: true, nestingDepth: 1, hideSeparator: true },
      { style: { borderBottomWidth: 0 } },
    );
  });

  it('attached below: no bottom padding or separator', () => {
    compareRows({ post: makeRow('image', 'attached'), attachedBelow: true });
  });

  it('the focused post of a detail page', () => {
    compareRows({ post: makeRow('text', 'detail'), isPostDetail: true });
    compareRows({ post: makeRow('quote', 'detail'), isPostDetail: true });
  });

  it('edited and private-mention markers', () => {
    const post = makeRow('text', 'marked');
    const { language } = compareRows({
      post: {
        ...post,
        metadata: { ...post.metadata, isEdited: true, visibility: PostVisibility.DIRECT },
      } as PostItemProps['post'],
    });
    expect(language.some((node) => node.props.accessibilityLabel === 'Edited')).toBe(true);
    expect(language.some((node) => node.props.testID === 'post-private-mention-badge')).toBe(true);
  });
});
