import type { ShadowRelease } from './jevShadow';
import type { ShadowTopic } from './jevSdk';
import type { ShadowReceiptAuthority } from './jevReceipt';

export const MENTION_JEV_APPLICATION_ID = '6a2f851751b784a86fd0e916';

/** A source-reviewed product binding, never a caller body or environment flag. */
export interface MentionJevProductionApproval {
  readonly scope: 'native-original-public';
  readonly deploymentId: string;
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
