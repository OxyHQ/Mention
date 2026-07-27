import { closeQueues } from '../../queue/queues';
import { closeQueueConnection } from '../../queue/connection';
import { closeRedisConnection } from '../../utils/redis';

/**
 * Close the lazily-created producer resources an administrative script may have
 * opened through federation/media services. Queue handles must close before
 * their shared ioredis connection. Every function is safe when never initialized.
 */
export async function closeAdminScriptResources(): Promise<void> {
  await closeQueues();
  await Promise.all([
    closeQueueConnection(),
    closeRedisConnection(),
  ]);
}

export function assertAdminRunComplete(
  scriptName: string,
  issues: Readonly<Record<string, number>>,
): void {
  const unresolved = Object.entries(issues).filter(([, count]) => count > 0);
  if (unresolved.length === 0) return;

  throw new Error(
    `[${scriptName}] run incomplete: ` +
      unresolved.map(([name, count]) => `${name}=${count}`).join(', '),
  );
}
