import { scanTextEntities } from '@mention/shared-types/textEntities';

/**
 * Text that overshoots the limit by less than this fraction is shown whole:
 * a "Read more" that reveals a few words isn't worth the tap.
 */
const TRUNCATION_TOLERANCE = 0.1;

/**
 * Pure truncation logic shared by post body text and profile bios. Both
 * "Read more" (post, when the openPost setting is off) and profile bio use
 * the identical truncate/expand shape; only the UI around it differs, which
 * is why this stays a plain function with no React/RN dependency.
 */
export function computeExpandableText(
  text: string,
  maxChars: number,
  isExpanded: boolean,
): { displayText: string; isTruncated: boolean } {
  // Hydrated mentions contain a label and a hidden identity destination. The
  // preview budget counts the label, never the serialized markup or target.
  const mentions = scanTextEntities(text, { kinds: ['mentionDisplay'] });
  // `mentionDisplay` entities always carry a string label in the shared parser;
  // the type is optional because other entity kinds do not have labels.
  const visibleLength = mentions.reduce(
    (length, mention) => length - mention.raw.length + (mention.label as string).length,
    text.length,
  );
  const isTruncated = visibleLength > maxChars * (1 + TRUNCATION_TOLERANCE);
  if (!isTruncated || isExpanded) {
    return { displayText: text, isTruncated };
  }
  let remaining = Math.max(0, maxChars);
  let sourceOffset = 0;
  let preview = '';
  for (const mention of mentions) {
    const prose = text.slice(sourceOffset, mention.start);
    if (remaining <= prose.length) {
      return { displayText: `${preview}${prose.slice(0, remaining).trimEnd()}…`, isTruncated };
    }
    preview += prose;
    remaining -= prose.length;
    const label = mention.label as string;
    if (remaining < label.length) {
      // Keep valid mention syntax and its complete destination even when only
      // part of the label is visible. LinkifiedText still renders a real link.
      return {
        displayText: `${preview}[@${label.slice(0, remaining).trimEnd()}…](${mention.value})`,
        isTruncated,
      };
    }
    preview += mention.raw;
    remaining -= label.length;
    sourceOffset = mention.end;
  }
  return {
    displayText: `${preview}${text.slice(sourceOffset, sourceOffset + remaining).trimEnd()}…`,
    isTruncated,
  };
}
