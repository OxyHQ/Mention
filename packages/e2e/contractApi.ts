import type { BrowserContext } from '@playwright/test';
import { API_ORIGIN } from './environment';

const contractContexts = new WeakSet<BrowserContext>();

/** Stop fixture-owned scripts before removing the boundary during teardown. */
export async function closeContractPages(context: BrowserContext): Promise<void> {
  if (!contractContexts.has(context)) return;
  await Promise.all(context.pages().map((page) => page.close()));
}

/**
 * Opt-in backend for synthetic UI contracts. Subject data (feeds, posts, search,
 * etc.) must be supplied by each test. Only unrelated public chrome is empty.
 * Unknown requests fail the test instead of escaping to production or receiving
 * a catch-all successful response. Live release flows do not install this.
 */
export async function installContractApi(context: BrowserContext): Promise<string[]> {
  contractContexts.add(context);
  const unexpected: string[] = [];
  const apiHost = new URL(API_ORIGIN).host;
  await context.routeWebSocket(
    (url) => url.host === apiHost,
    (socket) => {
      if (new URL(socket.url()).pathname !== '/socket.io/') {
        unexpected.push(`WS ${new URL(socket.url()).pathname}`);
        void socket.close({ code: 1008, reason: 'Unowned synthetic endpoint' });
        return;
      }
      // Deliberately quiet local connection: no connectToServer(), production
      // events, presence, or client messages escape this fixture-owned test.
      socket.onMessage(() => undefined);
    },
  );

  await context.route(
    (url) => url.origin === API_ORIGIN,
    async (route) => {
      const { pathname } = new URL(route.request().url());
      const method = route.request().method();
      if (method === 'GET' || method === 'HEAD') {
        let json: unknown;
        if (pathname === '/') json = { status: 'ok' };
        else if (pathname === '/trending') json = { trending: [], count: 0 };
        else if (pathname === '/recommendations')
          json = { recommendations: [], nextCursor: null, nextOffset: null, hasMore: false };
        else if (pathname === '/lanes') json = { data: [] };
        else if (/^\/profile\/design\/[^/]+$/.test(pathname))
          json = { privacy: { profileVisibility: 'public' } };
        else if (/^\/feed\/user\/[^/]+\/pinned$/.test(pathname)) json = { item: null };
        else if (/^\/commerce\/accounts\/[^/]+$/.test(pathname)) json = { state: 'disconnected' };
        else if (/^\/feed\/replies\/[^/]+$/.test(pathname)) json = { items: [], hasMore: false };
        else if (/^\/feed\/thread-continuations\/[^/]+$/.test(pathname)) json = { items: [] };
        if (json !== undefined) {
          await route.fulfill({ json });
          return;
        }
      }
      // Synthetic post impressions and client diagnostics must not write real
      // production analytics. These responses carry no entitlement or content.
      if (method === 'POST' && ['/telemetry/web', '/feed/mtn/interactions'].includes(pathname)) {
        await route.fulfill({ status: 204 });
        return;
      }
      if (method === 'POST' && /^\/statistics\/post\/[^/]+\/view$/.test(pathname)) {
        await route.fulfill({ json: { viewsCount: 0 } });
        return;
      }
      unexpected.push(`${method} ${pathname}`);
      await route.abort('blockedbyclient');
    },
  );
  return unexpected;
}
