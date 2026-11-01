import { Profiler, useState, type ProfilerOnRenderCallback } from 'react';
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { appI18n, initializeI18n } from '@/lib/i18n';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { GroupedNotification } from '@/utils/groupNotifications';
import { NotificationItem } from '../NotificationItem';

// Keep the SDK boundary mocked like the feed harness, but provide the viewer and
// query keys required for a real pending collaboration and expandable group.
jest.mock('@oxy.so/services/ui/client', () => {
  const base = jest.requireMock('@oxy.so/services');
  return new Proxy(base, {
    get(target, key) {
      if (key === 'useAuth') return () => ({ user: { id: 'viewer' } });
      if (key === 'queryKeys') return { users: { detail: (id: string) => ['users', id] } };
      return Reflect.get(target, key);
    },
  });
});

type Kind = 'ordinary' | 'collaboration' | 'group';
const BATCH = 16;
const RUNS = 7;
const callbacks = {
  onMarkAsRead: () => {},
  onDelete: () => {},
  captureIntent: () => ({ viewerId: 'viewer', epoch: 1 }),
  isCurrentIntent: () => true,
  ownNotificationSurface: async <T,>(
    _intent: unknown,
    present: (signal: AbortSignal) => Promise<T>,
  ) => present(new AbortController().signal),
};
function row(kind: Kind, index: number): GroupedNotification {
  const type = kind === 'collaboration' ? 'collab_invite' : 'like';
  const raw = {
    _id: `notification-${kind}-${index}`,
    recipientId: 'viewer',
    actorId: 'actor-a',
    type,
    entityId: 'post',
    entityType: 'post',
    read: false,
    createdAt: '2026-11-01T12:00:00.000Z',
    actorId_populated: { id: 'actor-a', username: 'actor-a', name: { displayName: 'Actor A' } },
  };
  const actors = [{ id: 'actor-a', username: 'actor-a', name: 'Actor A' }];
  if (kind === 'group') actors.push({ id: 'actor-b', username: 'actor-b', name: 'Actor B' });
  return {
    key: raw._id,
    type,
    entityId: 'post',
    entityType: 'post',
    hasUnread: true,
    createdAt: raw.createdAt,
    actors,
    totalActors: actors.length,
    notificationIds: [raw._id],
    leadNotification: raw,
    isGroup: kind === 'group',
    expandable: kind === 'group',
  } as GroupedNotification;
}
function countHost(node: ReactTestRendererJSON | ReactTestRendererJSON[] | null): number {
  if (!node) return 0;
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countHost(child), 0);
  return (
    1 +
    (node.children ?? []).reduce<number>(
      (sum, child) => sum + (typeof child === 'string' ? 0 : countHost(child)),
      0,
    )
  );
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test('measures native notification rows by kind', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initializeI18n();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(viewerQueryKeys.post('viewer', 'post'), {
    id: 'post',
    content: { text: 'fixture' },
    viewerState: { collabInvitePending: true },
  });
  let setRows!: (value: GroupedNotification[]) => void;
  let actual = 0;
  const onRender: ProfilerOnRenderCallback = (_id, _phase, duration) => {
    actual = duration;
  };
  function Rows() {
    const [rows, set] = useState<GroupedNotification[]>([]);
    setRows = set;
    return (
      <Profiler id="notifications" onRender={onRender}>
        {rows.map((item) => (
          <NotificationItem key={item.key} item={item} {...callbacks} />
        ))}
      </Profiler>
    );
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <BloomProvider fonts={false} haptics={false} defaultMode="light">
        <QueryClientProvider client={client}>
          <I18nextProvider i18n={appI18n}>
            <Rows />
          </I18nextProvider>
        </QueryClientProvider>
      </BloomProvider>,
    );
  });
  const emptyComponents = renderer.root.findAll(() => true).length;
  const emptyHosts = countHost(renderer.toJSON());
  const output: Record<string, unknown> = {};
  for (const kind of ['ordinary', 'collaboration', 'group'] as const) {
    const durations: number[] = [];
    const wallDurations: number[] = [];
    let components = 0;
    let hosts = 0;
    let targets = 0;
    for (let run = 0; run < RUNS + 1; run++) {
      const rows = Array.from({ length: BATCH }, (_, index) => row(kind, index));
      const started = process.hrtime.bigint();
      act(() => setRows(rows));
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000 / BATCH;
      const rendered = JSON.stringify(renderer.toJSON());
      if (kind === 'collaboration') expect(rendered).toContain('Accept');
      if (kind === 'group') expect(rendered).toContain('Show all');
      if (run > 0) {
        durations.push(actual / BATCH);
        wallDurations.push(elapsed);
      }
      components = (renderer.root.findAll(() => true).length - emptyComponents) / BATCH;
      hosts = (countHost(renderer.toJSON()) - emptyHosts) / BATCH;
      targets =
        renderer.root.findAll((node) => typeof node.props.onLongPress === 'function').length /
        BATCH;
      act(() => setRows([]));
    }
    output[kind] = {
      mountMsPerRow: median(durations),
      mountWallMsPerRow: median(wallDurations),
      componentsPerRow: components,
      hostNodesPerRow: hosts,
      longPressTargetsPerRow: targets,
    };
  }
  console.log('NOTIFICATION_ROW_BENCH', JSON.stringify(output));
  act(() => renderer.unmount());
  client.clear();
});
