import { FEDERATION_DOMAIN } from '@/config';

/**
 * The fediverse handle of one of THIS instance's accounts, `@<username>@<domain>`,
 * on the federation domain (`FEDERATION_DOMAIN`). Never built from the web host:
 * the handle stays `@user@mention.earth` after the web moves to mention.org
 * (docs/mention-org-domain-move.md).
 */
export function localFederatedHandle(username: string): string {
  return `@${username}@${FEDERATION_DOMAIN}`;
}
