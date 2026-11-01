import type { SupervisedAction } from '@oxy.so/contracts';
import type { Request } from 'express';

/** An audited endpoint, not a router namespace, earns a supervised capability. */
export function supervisedActionForRequest(
  req: Pick<Request, 'baseUrl' | 'path' | 'method'>,
): SupervisedAction | undefined {
  const path = `${req.baseUrl}${req.path}`.replace(/^\/api(?=\/|$)/, '').replace(/\/$/, '');
  const method = req.method.toUpperCase();
  if (path.startsWith('/media/')) return 'content';
  if (method === 'GET' && /^\/articles\/[^/]+$/.test(path)) return 'content';
  if (path === '/posts') return 'content';
  if (method === 'GET' && /^\/posts\/[^/]+\/edit-source$/.test(path)) return 'content';
  if (method === 'POST' && path === '/posts/thread') return 'content';
  if (method === 'GET' && /^\/posts\/(hashtag|topic)\/[^/]+$/.test(path)) return 'content';
  // These handlers expose assembled posts; unreviewed helpers (corrections,
  // link previews, translations, engagement lists and geography) stay closed.
  if (
    /^\/posts\/[^/]+$/.test(path) &&
    ![
      'drafts',
      'scheduled',
      'saved',
      'nearby',
      'in-area',
      'nearby-all',
      'location-stats',
      'translate-draft',
      'link-previews',
      'documents',
    ].includes(path.split('/')[2]) &&
    ['GET', 'PUT', 'DELETE'].includes(method)
  )
    return 'content';
  if (
    /^\/feed\/(mtn|mtn\/peek|replies\/[^/]+|quotes\/[^/]+|thread\/[^/]+|user\/[^/]+\/pinned|item\/[^/]+)$/.test(
      path,
    ) &&
    method === 'GET'
  )
    return 'content';
  if (path === '/feed/mtn/interactions' && method === 'POST') return 'content';
  // These guarded endpoints are the same audited mutations as their legacy
  // counterparts. Match each method and shape; the prefix grants nothing else.
  if (
    (method === 'PATCH' &&
      /^\/notifications\/_viewer\/(?:read-all|[^/]+\/(?:read|archive))$/.test(path)) ||
    (method === 'DELETE' && /^\/notifications\/_viewer\/[^/]+$/.test(path))
  )
    return 'content';
  if (
    /^\/notifications(?:\/[^/]+(?:\/read|\/archive)?)?$/.test(path) &&
    path !== '/notifications/push-test'
  )
    return 'content';
  // The shared Oxy policy rejects supervised credentials on every other route;
  // ordinary adult sessions keep their existing authorization and features.
  return undefined;
}
