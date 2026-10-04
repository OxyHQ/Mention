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

/**
 * No Mention deployment/funding approval exists yet. Public OpenRouter access
 * and Alia's bounded synthetic pilot cannot authorize Mention's product lane.
 * Replace this absence only with an independently reviewed exact source record.
 */
export function reviewedMentionJevProduction(): MentionJevProductionApproval | undefined {
  return undefined;
}
