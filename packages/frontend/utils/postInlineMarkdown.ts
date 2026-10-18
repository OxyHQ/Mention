import { parseInlineMarkdown, type MarkdownInline } from '@oxy.so/bloom/markdown/inline';
import { scanLinkifyEntities, type LinkifyEntity } from './linkifyPattern';
import { toOpenableUrl } from '@mention/shared-types/textEntities';

/** Match identities against the original link, before its visible label is clipped. */
export function postMentionForLink(
  mentions: readonly LinkifyEntity[],
  url: string,
  label?: string,
) {
  return mentions.find((mention) =>
    label === undefined
      ? mention.unverified && toOpenableUrl(mention.raw) === url
      : mention.value === url && label === `@${mention.label}`,
  );
}

/** Hydrated identity labels are literal names, never formatting instructions. */
export function parsePostInlineMarkdown(source: string) {
  const mentions = scanLinkifyEntities(source).filter((entity) => entity.kind === 'mentionDisplay');
  const normalize = (nodes: readonly MarkdownInline[]): MarkdownInline[] =>
    nodes.map((node) => {
      if (node.type === 'link') {
        const mention = postMentionForLink(mentions, node.url, node.label);
        if (mention) return { ...node, children: [{ type: 'text', value: mention.label ?? '' }] };
      }
      return 'children' in node ? { ...node, children: normalize(node.children) } : node;
    });
  return { nodes: normalize(parseInlineMarkdown(source)), mentions };
}
