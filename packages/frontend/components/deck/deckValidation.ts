import type { PanelNavigationState } from '@oxy.so/bloom/app-shell';
import { DECK_LIMITS, type DeckPanelState, type DeckRouteParam } from '@mention/shared-types/deck';
import type { DeckSnapshot, DeckPanelSettings } from './deckSettings';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const validText = (value: string) =>
  !value.includes('\0') &&
  Array.from(value).every(
    (char) => char.length === 2 || char.charCodeAt(0) < 0xd800 || char.charCodeAt(0) > 0xdfff,
  );
const safeKey = (value: unknown, limit = 256): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= limit &&
  !['__proto__', 'prototype', 'constructor'].includes(value) &&
  !/[\x00-\x1f\x7f]/.test(value) &&
  validText(value);
const routeName = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const decoded = decodeURIComponent(value);
    return (
      decoded.startsWith('/') &&
      !decoded.startsWith('//') &&
      !decoded.includes('\\') &&
      !/[\x00-\x1f\x7f]/.test(decoded) &&
      validText(decoded)
    );
  } catch {
    return false;
  }
};
function jsonBytes(value: unknown): number {
  let bytes = 0;
  for (const char of JSON.stringify(value) ?? '') {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
export function normalizeNavigation(value: PanelNavigationState): DeckPanelState['navigation'] {
  if (
    !Array.isArray(value.entries) ||
    !Number.isInteger(value.index) ||
    value.index < 0 ||
    value.index >= value.entries.length
  )
    return;
  const start = Math.max(
    0,
    Math.min(
      value.index - Math.floor(DECK_LIMITS.historyEntries / 2),
      value.entries.length - DECK_LIMITS.historyEntries,
    ),
  );
  const entries = value.entries.slice(start, start + DECK_LIMITS.historyEntries);
  if (entries.some((entry) => !object(entry) || !safeKey(entry.key) || !routeName(entry.name)))
    return;
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) return;
  return {
    index: value.index - start,
    entries: entries.map((entry) => {
      const params: Record<string, DeckRouteParam> = {};
      let remainingBytes = Math.max(
        0,
        8192 - jsonBytes({ key: entry.key, name: entry.name, params: {} }),
      );
      for (const [key, v] of Object.entries(entry.params ?? {}).slice(0, 32)) {
        if (!safeKey(key)) continue;
        if (
          v === null ||
          (typeof v === 'string' && v.length <= 2048 && validText(v)) ||
          typeof v === 'boolean' ||
          (typeof v === 'number' && Number.isFinite(v)) ||
          (Array.isArray(v) &&
            v.length <= 32 &&
            v.every((item) => typeof item === 'string' && item.length <= 2048 && validText(item)))
        ) {
          const bytes = jsonBytes({ [key]: v });
          if (bytes <= remainingBytes) {
            params[key] = v;
            remainingBytes -= bytes;
          }
        }
      }
      return {
        key: entry.key,
        name: entry.name,
        ...(Object.keys(params).length ? { params } : {}),
      };
    }),
  };
}
/** Storage is untrusted and can outlive app versions. Never hydrate arbitrary shape. */
export function normalizeDeckSnapshot(value: unknown): DeckSnapshot | null {
  if (JSON.stringify(value)?.length > DECK_LIMITS.payloadBytes) return null;
  if (!object(value) || !object(value.panels) || !Array.isArray(value.order)) return null;
  const panels: Record<string, DeckPanelSettings> = {};
  for (const [id, candidate] of Object.entries(value.panels).slice(0, DECK_LIMITS.panels)) {
    if (
      !safeKey(id, 100) ||
      !/^[a-zA-Z0-9_-]+$/.test(id) ||
      !object(candidate) ||
      !['explore', 'trending', 'following', 'saved'].includes(candidate.source as string) ||
      !['solid', 'plain'].includes(candidate.appearance as string) ||
      typeof candidate.width !== 'number' ||
      !Number.isFinite(candidate.width)
    )
      continue;
    const p: DeckPanelSettings = {
      source: candidate.source as DeckPanelSettings['source'],
      width: Math.max(300, Math.min(620, candidate.width)),
      resizable: candidate.resizable === true,
      appearance: candidate.appearance as DeckPanelSettings['appearance'],
    };
    if (
      typeof candidate.colorPreset === 'string' &&
      /^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(candidate.colorPreset)
    )
      p.colorPreset = candidate.colorPreset as DeckPanelSettings['colorPreset'];
    if (typeof candidate.liveUpdates === 'boolean') p.liveUpdates = candidate.liveUpdates;
    if (typeof candidate.pauseWhileReading === 'boolean')
      p.pauseWhileReading = candidate.pauseWhileReading;
    if (object(candidate.navigation))
      p.navigation = normalizeNavigation(candidate.navigation as unknown as PanelNavigationState);
    if (object(candidate.scrollOffsets))
      p.scrollOffsets = Object.fromEntries(
        Object.entries(candidate.scrollOffsets)
          .filter(
            ([key, v]) =>
              safeKey(key, 4096) &&
              typeof v === 'number' &&
              Number.isFinite(v) &&
              v >= 0 &&
              v <= 100_000_000,
          )
          .slice(-DECK_LIMITS.scrollOffsets),
      ) as Record<string, number>;
    panels[id] = p;
  }
  if (value.syncEnabled !== false && !Object.keys(panels).length) return null;
  const order = [
    ...new Set([
      ...value.order.filter(
        (id): id is string => typeof id === 'string' && Object.hasOwn(panels, id),
      ),
      ...Object.keys(panels),
    ]),
  ];
  return {
    syncEnabled: value.syncEnabled !== false,
    panels,
    order,
    ...(typeof value.activePanel === 'string' && Object.hasOwn(panels, value.activePanel)
      ? { activePanel: value.activePanel }
      : {}),
  };
}

/** Keep current pages while evicting old restoration/history data before the API limit. */
export function boundDeckSnapshot(snapshot: DeckSnapshot): DeckSnapshot {
  const budget = DECK_LIMITS.payloadBytes - 1024;
  if (jsonBytes(snapshot) <= budget && Object.keys(snapshot.panels).length <= DECK_LIMITS.panels)
    return snapshot;
  const panels = Object.fromEntries(
    snapshot.order
      .filter((id) => snapshot.panels[id])
      .slice(0, DECK_LIMITS.panels)
      .map((id) => [id, snapshot.panels[id]] as const)
      .map(([id, panel]) => [id, { ...panel, scrollOffsets: undefined }]),
  );
  const next = {
    ...snapshot,
    panels,
    order: snapshot.order.filter((id) => Object.hasOwn(panels, id)),
    activePanel:
      snapshot.activePanel && Object.hasOwn(panels, snapshot.activePanel)
        ? snapshot.activePanel
        : undefined,
  };
  if (jsonBytes(next) <= budget) return next;
  for (const panel of Object.values(panels)) {
    if (panel.navigation)
      panel.navigation = normalizeNavigation({
        entries: [panel.navigation.entries[panel.navigation.index]],
        index: 0,
      });
  }
  return next;
}
