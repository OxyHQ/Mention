import { DECK_LIMITS, DECK_SOURCES } from '@mention/shared-types/deck';
import { z } from 'zod';

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}
function validText(value: string): boolean {
  return (
    !value.includes('\0') &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return character.length === 2 || code < 0xd800 || code > 0xdfff;
    })
  );
}
const boundedText = z.string().max(2048).refine(validText, 'Invalid Unicode text');
const stateKey = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine(
      (value) =>
        !['__proto__', 'prototype', 'constructor'].includes(value) &&
        !hasControlCharacters(value) &&
        validText(value),
      'Invalid state key',
    );
const safeKey = stateKey(256);
// Bloom snapshots URI-encode composite keys; the encoded subkey can include a route.
const scrollKey = stateKey(4096);
const panelId = safeKey.refine((value) => /^[a-zA-Z0-9_-]{1,100}$/.test(value), 'Invalid panel id');
const param = z.union([
  boundedText,
  z.array(boundedText).max(32),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const internalRoute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    try {
      const decoded = decodeURIComponent(value);
      return (
        decoded.startsWith('/') &&
        !decoded.startsWith('//') &&
        !decoded.includes('\\') &&
        !hasControlCharacters(decoded) &&
        validText(decoded) &&
        new URL(value, 'https://mention.invalid').origin === 'https://mention.invalid'
      );
    } catch {
      return false;
    }
  }, 'Expected an internal app route');
const navigation = z
  .object({
    entries: z
      .array(
        z
          .object({
            key: safeKey,
            name: internalRoute,
            params: z
              .record(safeKey, param)
              .refine((value) => Object.keys(value).length <= 32)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(DECK_LIMITS.historyEntries),
    index: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) =>
      value.index < value.entries.length &&
      new Set(value.entries.map((entry) => entry.key)).size === value.entries.length,
    'Navigation must select an entry and have unique history keys',
  );
const panel = z
  .object({
    source: z.enum(DECK_SOURCES),
    width: z.number().finite().min(300).max(620),
    resizable: z.boolean(),
    appearance: z.enum(['solid', 'plain']),
    colorPreset: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/)
      .optional(),
    liveUpdates: z.boolean().optional(),
    pauseWhileReading: z.boolean().optional(),
    navigation: navigation.optional(),
    scrollOffsets: z
      .record(scrollKey, z.number().finite().min(0).max(100_000_000))
      .refine((value) => Object.keys(value).length <= DECK_LIMITS.scrollOffsets)
      .optional(),
  })
  .strict();

export const deckWorkspaceUpdateSchema = z
  .object({
    baseRevision: z.number().int().min(0).max(2_147_483_646),
    state: z
      .object({
        syncEnabled: z.boolean().default(true),
        panels: z
          .record(panelId, panel)
          .refine((value) => Object.keys(value).length <= DECK_LIMITS.panels),
        order: z.array(panelId).max(DECK_LIMITS.panels),
        activePanel: panelId.optional(),
      })
      .strict()
      .refine((state) => {
        const ids = Object.keys(state.panels);
        return (
          state.order.length === ids.length &&
          new Set(state.order).size === ids.length &&
          state.order.every((id) => Object.hasOwn(state.panels, id)) &&
          (state.activePanel === undefined || Object.hasOwn(state.panels, state.activePanel))
        );
      }, 'Panel order and selection must reference exactly the stored panels'),
  })
  .strict();
