import type { SupervisedAction } from '@oxy.so/contracts';
import type { OxyServer } from '@oxy.so/core/server';
import type { RequestHandler } from 'express';
import { supervisedActionForRequest } from './supervisedAction';

/**
 * The `oxy.middleware.auth()` mounts every Oxy-session route goes through, built
 * ONCE per server and per supervised action. The only thing a request decides
 * is which audited supervised-content endpoint it is
 * (`supervisedActionForRequest`, a closed set), so it selects a mount rather
 * than building one per request. The accepted service-token audience is the
 * server's own `expectedAudience` (`runtime/oxyClient`).
 */
export function createOxySessionAuth(oxy: OxyServer): RequestHandler {
  const mounts = new Map<SupervisedAction | undefined, RequestHandler>();
  const mountFor = (supervisedAction: SupervisedAction | undefined): RequestHandler => {
    let mount = mounts.get(supervisedAction);
    if (!mount) {
      mount = oxy.middleware.auth(supervisedAction ? { supervisedAction } : {});
      mounts.set(supervisedAction, mount);
    }
    return mount;
  };
  return (req, res, next) => mountFor(supervisedActionForRequest(req))(req, res, next);
}
