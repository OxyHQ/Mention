/**
 * The schema.org type of a profile's entity. Mirrors the server's rule
 * (`schemaOrgProfileType` in the backend renderer): a personal account is a
 * `Person`, and every other kind is an `Organization`, since schema.org has no
 * type for a bot or a community. An unknown kind is a `Person`, as there.
 */
const ORGANIZATION_ACCOUNT_KINDS: ReadonlySet<string> = new Set([
  'organization',
  'project',
  'bot',
  'channel',
  'community',
]);

export function schemaOrgEntityType(kind: string | undefined): 'Person' | 'Organization' {
  return kind && ORGANIZATION_ACCOUNT_KINDS.has(kind) ? 'Organization' : 'Person';
}
