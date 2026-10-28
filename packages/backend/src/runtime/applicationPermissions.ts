/** Declare this vocabulary in Oxy Console for this deployment's registered application. */
export const APPLICATION_PERMISSIONS = [
  {
    key: 'memberships.moderate',
    description: 'Inspect and moderate reported membership content with a durable access audit.',
  },
] as const;
export const MEMBERSHIP_MODERATION_PERMISSION = APPLICATION_PERMISSIONS[0].key;
