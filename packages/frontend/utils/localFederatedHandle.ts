import { FEDERATION_HANDLE_DOMAIN } from '@/config';

/**
 * The fediverse handle of one of THIS instance's accounts, `@<username>@<domain>`,
 * on the handle domain (`FEDERATION_HANDLE_DOMAIN`, which is `FEDERATION_DOMAIN`
 * unless `EXPO_PUBLIC_FEDERATION_HANDLE_DOMAIN` is set). Never built from the web
 * host: the handle stays `@user@mention.earth` after the web moves to mention.org,
 * until the handle domain itself is switched (docs/mention-org-domain-move.md).
 */
export function localFederatedHandle(username: string): string {
  return `@${username}@${FEDERATION_HANDLE_DOMAIN}`;
}
