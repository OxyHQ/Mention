import { reconcileMentionIds } from '@mention/shared-types/mentions';

/**
 * Composer-only display metadata for an authorized mention id.
 *
 * Empty display fields are valid while restoring an old draft or editing during
 * an Oxy lookup outage. In that case the stable placeholder and id are
 * preserved, but the input does not invent a handle.
 */
export interface MentionData {
  userId: string;
  username: string;
  displayName: string;
}

export interface MentionTextValue {
  text: string;
  mentions: MentionData[];
}

function cleanMention(mention: MentionData): MentionData | null {
  const userId = mention.userId?.trim();
  if (!userId) return null;
  const username = mention.username?.trim() ?? '';
  const displayName = mention.displayName?.trim() || username;
  return { userId, username, displayName };
}

/**
 * Merge metadata registries by stable user id, preferring non-empty identity
 * fields. This is useful when a newly selected mention joins entries restored
 * from a draft whose public profile could not currently be resolved.
 */
export function mergeMentionData(
  ...registries: readonly (readonly MentionData[])[]
): MentionData[] {
  const merged = new Map<string, MentionData>();
  for (const registry of registries) {
    for (const raw of registry) {
      const mention = cleanMention(raw);
      if (!mention) continue;
      const previous = merged.get(mention.userId);
      if (!previous) {
        merged.set(mention.userId, mention);
        continue;
      }
      merged.set(mention.userId, {
        userId: mention.userId,
        username: mention.username || previous.username,
        displayName:
          mention.displayName ||
          previous.displayName ||
          mention.username ||
          previous.username,
      });
    }
  }
  return [...merged.values()];
}

/**
 * Keep composer metadata exactly scoped to authorized placeholders that remain
 * in the supplied body renditions. Placeholder text alone never creates a new
 * metadata entry or notification recipient.
 */
export function reconcileMentionData(
  texts: Iterable<string | null | undefined>,
  candidates: readonly MentionData[],
): MentionData[] {
  const normalized = mergeMentionData(candidates);
  const byId = new Map(normalized.map((mention) => [mention.userId, mention]));
  return reconcileMentionIds(texts, [...byId.keys()])
    .map((id) => byId.get(id))
    .filter((mention): mention is MentionData => mention !== undefined);
}

export function reconcileMentionTextValue(
  value: MentionTextValue,
  additionalTexts: Iterable<string | null | undefined> = [],
): MentionTextValue {
  return {
    text: value.text,
    mentions: reconcileMentionData([value.text, ...additionalTexts], value.mentions),
  };
}

export function areMentionDataEqual(
  left: readonly MentionData[],
  right: readonly MentionData[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (mention, index) =>
        mention.userId === right[index]?.userId &&
        mention.username === right[index]?.username &&
        mention.displayName === right[index]?.displayName,
    )
  );
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

/**
 * Render only known mention placeholders as handles. An unresolved or
 * unauthorized placeholder remains visible as-is instead of fabricating an
 * identity.
 */
export function storageTextToDisplayText(
  storageText: string,
  mentions: readonly MentionData[],
): string {
  let result = storageText;
  for (const mention of mergeMentionData(mentions)) {
    if (!mention.username) continue;
    result = replaceAllLiteral(
      result,
      `[mention:${mention.userId}]`,
      `@${mention.username}`,
    );
  }
  return result;
}

const HANDLE_CONTINUATION = /[\p{L}\p{N}_@]/u;

function hasHandleContinuation(character: string | undefined): boolean {
  return Boolean(character && HANDLE_CONTINUATION.test(character));
}

function continuesHandleAfter(text: string, index: number): boolean {
  const character = text[index];
  if (hasHandleContinuation(character)) return true;
  if (character !== '.' && character !== '-') return false;
  return hasHandleContinuation(text[index + 1]);
}

function replaceDisplayMention(
  displayText: string,
  username: string,
  userId: string,
): string {
  const needle = `@${username}`;
  if (needle.length <= 1) return displayText;

  let result = '';
  let cursor = 0;
  while (cursor < displayText.length) {
    const matchIndex = displayText.indexOf(needle, cursor);
    if (matchIndex === -1) {
      result += displayText.slice(cursor);
      break;
    }

    const before = matchIndex > 0 ? displayText[matchIndex - 1] : undefined;
    const afterIndex = matchIndex + needle.length;
    if (
      hasHandleContinuation(before) ||
      continuesHandleAfter(displayText, afterIndex)
    ) {
      result += displayText.slice(cursor, afterIndex);
      cursor = afterIndex;
      continue;
    }

    result += displayText.slice(cursor, matchIndex);
    result += `[mention:${userId}]`;
    cursor = afterIndex;
  }
  return result;
}

/**
 * Convert handles that belong to the controlled metadata registry back to
 * storage placeholders. Bare handles with no selected metadata remain text.
 */
export function displayTextToStorageText(
  displayText: string,
  mentions: readonly MentionData[],
): string {
  const known = mergeMentionData(mentions)
    .filter((mention) => mention.username.length > 0)
    .sort((left, right) => right.username.length - left.username.length);

  let result = displayText;
  for (const mention of known) {
    result = replaceDisplayMention(result, mention.username, mention.userId);
  }
  return result;
}
