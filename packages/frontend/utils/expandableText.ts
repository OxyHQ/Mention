/**
 * Pure truncation logic shared by post body text and profile bios. Both
 * "Read more" (post, when the openPost setting is off) and profile bio use
 * the identical truncate/expand shape; only the UI around it differs, which
 * is why this stays a plain function with no React/RN dependency.
 */
export function computeExpandableText(
  text: string,
  maxChars: number,
  isExpanded: boolean
): { displayText: string; isTruncated: boolean } {
  const isTruncated = text.length > maxChars;
  if (!isTruncated || isExpanded) {
    return { displayText: text, isTruncated };
  }
  return { displayText: `${text.slice(0, maxChars).trimEnd()}…`, isTruncated };
}
