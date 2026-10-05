import type { ShadowRelease, ShadowSelection } from './jevShadow';
import type { ShadowTopic } from './jevSdk';
import type { ShadowReceiptAuthority } from './jevReceipt';

export const MENTION_JEV_APPLICATION_ID = '6a2f851751b784a86fd0e916';
export const MENTION_JEV_OWNER_ACCOUNT_ID = '69b2d3df5d12f58c9800d651';
export const MENTION_JEV_WORKLOAD_CREDENTIAL_ID = 'wl_d61be5cd068abb658ed4d193';

/** Independent evidence required for the bounded native lane; federated input stays excluded. */
export const MENTION_NATIVE_JEV_CONTROLS = Object.freeze([
  'publishedSdk', 'exactPrivateRoute', 'ownAuthorityAndEconomics',
  'privacyAndZdr', 'semanticIdentityAndRecovery',
] as const);
export type MentionNativeJevReviews = Readonly<Record<typeof MENTION_NATIVE_JEV_CONTROLS[number], string>>;

/** A source-reviewed product binding, never a caller body or environment flag. */
export interface MentionJevProductionApproval {
  readonly scope: 'native-original-public';
  readonly ownerAccountId: string;
  readonly reviews: MentionNativeJevReviews;
  readonly selection: ShadowSelection;
  /** Review metadata only: public decisions/receipts do not attest the exact deployment.
   * Activation also requires Oxy resolver policy evidence pinning this deployment before dispatch. */
  readonly deploymentId: string;
  readonly provider: string;
  readonly priceVersionId: string;
  readonly evidenceRef: string;
  readonly validUntil: string;
  readonly release: ShadowRelease;
  readonly topics: readonly ShadowTopic[];
  readonly authority: ShadowReceiptAuthority;
}

/** Exact one-post source approval; caller bodies/environment cannot broaden it. */
const REVIEWED_NATIVE_APPROVAL = {
  "scope": "native-original-public",
  "ownerAccountId": "69b2d3df5d12f58c9800d651",
  "reviews": {
    "publishedSdk": "sha256:cfa11edd130945038782aa0098d90118a606e3f7473e03a2b39c9043deb83980",
    "exactPrivateRoute": "sha256:86460b564dfef98a6c8965909bfdbcaa298cd4507528d30e8da253308de65036",
    "ownAuthorityAndEconomics": "sha256:722179c399f4158895d2c962455351f9c19c132345c7294267c465b99ad19698",
    "privacyAndZdr": "sha256:32e67e4deb997f12f443fd6e4275f1fa2f51cad4cf852b2ace648ce51565eb4f",
    "semanticIdentityAndRecovery": "sha256:88f733e67a332becc586602d5b32c0094cf44f5463553bd3cdf790cb262d6ec7"
  },
  "selection": {
    "postId": "019fd378-8626-7df7-90ce-5c0629498e97",
    "fingerprint": "2fe852b84b3f01efa95d54fe6ccb8e73d6e23e9d9f5f117af0f6a3165b9209eb",
    "inputSha256": "a962e5ed49a962db7934684c62834dd25b04aba94162ad9d07140c9a2abeb3b2",
    "idempotencyKey": "mention_jev_native_en_8d04b9d17510fe89d7ae084039ee4231"
  },
  "deploymentId": "dep_openrouter_typesafe_jev_1_13_mention_native_2026_10_05",
  "provider": "openrouter",
  "priceVersionId": "jev_scoped_price_20261004_01",
  "evidenceRef": "sha256:613bde08e74fa7a3ff0c16b7d6e1a3310f2b3934b028add5ecbda5b1d0a46fba",
  "validUntil": "2026-10-05T03:14:23.000Z",
  "release": {
    "model": "typesafe/jev-1.13@2026-09-17",
    "policyRef": "platform-internal-default",
    "policyVersion": 1,
    "evaluationVersion": "mention-native-en-onepost/2026-10-05.1",
    "supportedLanguages": [
      "en"
    ]
  },
  "topics": [],
  "authority": {
    "applicationId": "6a2f851751b784a86fd0e916",
    "credentialId": "wl_d61be5cd068abb658ed4d193",
    "environment": "production"
  }
} satisfies MentionJevProductionApproval;

/** Admission expires; durable own receipt recovery remains independent. */
export function reviewedMentionJevProduction(): MentionJevProductionApproval | undefined {
  if (Date.now() >= Date.parse(REVIEWED_NATIVE_APPROVAL.validUntil)) return undefined;
  return structuredClone(REVIEWED_NATIVE_APPROVAL);
}
