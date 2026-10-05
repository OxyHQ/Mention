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
    "publishedSdk": "sha256:0ee091d3a02e11062089573a187dc018479d6e037c3ec090bf6d4ec1eb883d2d",
    "exactPrivateRoute": "sha256:167e3679110b73e1c7ed6a07e74d9ac8f41e2e6a8d2d5fd26ab0709249506d58",
    "ownAuthorityAndEconomics": "sha256:480cbac3c098517f50ebeb19616bd7c6f3681be323219e76e4ab38792f04c7f6",
    "privacyAndZdr": "sha256:dfa07321d19941a7d1fdb39d7bce78f143103afa1b3b3a77fd1975ec43670822",
    "semanticIdentityAndRecovery": "sha256:a5750feaf69b6819b953b681d7892f0a641b873e14054a5c8f8a48bf407447d1"
  },
  "selection": {
    "postId": "019fd378-8d12-70da-83ef-b2d39f86e192",
    "fingerprint": "454831da03d69cfbfd312779c426078ff97b39f42f2a17466bd3f46ae04b121b",
    "inputSha256": "207a9c8fa2847e7263d6e8d525a951bca72d82bfb762aeb37cf546ca8762966a",
    "idempotencyKey": "mention_jev_native_en_d5c4e4815e9bfb2b998af67bb7677011"
  },
  "deploymentId": "dep_openrouter_typesafe_jev_1_13_mention_native_second_2026_10_05",
  "provider": "openrouter",
  "priceVersionId": "jev_scoped_price_20261004_01",
  "evidenceRef": "sha256:801905abc8267496404b1ce23578f56ff5b8f0cc24fa6502d1f19cd3d2eba62c",
  "validUntil": "2026-10-05T05:21:15.000Z",
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
