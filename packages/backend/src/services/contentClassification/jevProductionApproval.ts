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
    "publishedSdk": "sha256:3fd42da244ee12af5d9017629f0c8eb75796e8ce04de735597cf8d01f7b51a2c",
    "exactPrivateRoute": "sha256:6f42d4dc5781eef5e21921ea97ff104baefe0605f6642038ce3a7d16769e9c6f",
    "ownAuthorityAndEconomics": "sha256:af2c5aabe1e316b5b1e4ffbdb92a01498dc43f59e5acaaba522de5a9faf7b35d",
    "privacyAndZdr": "sha256:54ed54b431a55cb678e8f4d47af6c15f648a8c98f5d22f5ab3fc81e76c76861a",
    "semanticIdentityAndRecovery": "sha256:6cbcbc7f98cba69ef614daf3595e27b3bcec0b3c2d0a6a0b3a18bd4fe65b73fe"
  },
  "selection": {
    "postId": "019fd378-8ea7-7b4f-acd0-1c83361e0413",
    "fingerprint": "b6118a879b0961cf1c25c040ea501ef7e4557228bea5f4f82dac2efa2e684222",
    "inputSha256": "0c12c43c70a269a40ca0e856af98c48db8d20573b2e1b7d75f9bd6f9468a73da",
    "idempotencyKey": "mention_jev_native_en_9aebfe5269e8fbe9e8c3961a93ef71d3"
  },
  "deploymentId": "dep_openrouter_typesafe_jev_1_13_mention_native_third_2026_10_05",
  "provider": "openrouter",
  "priceVersionId": "jev_scoped_price_20261004_01",
  "evidenceRef": "sha256:ea34cfaf7bc7e3b7743dcc6509d15f421b741de4e496269f913009b41b89b998",
  "validUntil": "2026-10-05T07:09:12.000Z",
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
