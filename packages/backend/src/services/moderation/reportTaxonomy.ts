import type { TaxonomyCode } from '@crowdsource.you/contracts';
import type { ReportCategory } from '../../db/moderation/reportRepository';

/**
 * Mention's report categories, translated into CrowdSource's universal taxonomy.
 *
 * The categories on the left are what a reporter picked in Mention's UI. The codes
 * on the right are ALLEGATIONS (§6.2) — what is claimed, never what is true. A
 * jury classifies the material itself and may confirm a different code entirely,
 * and nothing about this table shortens that.
 *
 * ## Why this is versioned
 *
 * §6.4 requires every decision to record the policy version it was decided under,
 * and this mapping is upstream of that: change what `spam` means and two reports
 * filed a month apart are no longer the same allegation. {@link REPORT_TAXONOMY_VERSION}
 * is stamped into the report metadata so a case can always be read back against
 * the mapping that produced it. Bump it in the same change that alters a row.
 *
 * ## The two rows worth arguing about
 *
 * **`misinformation` has no home.** §6.3's universal taxonomy has eleven families
 * and none of them is misinformation — the closest are `integrity.coordinated_manipulation`
 * (a claim about organised behaviour, which a reporter clicking "misinformation"
 * is not making) and `integrity.scam` (a claim about intent to defraud, likewise).
 * So it maps to `other.policy_specific`: a real code meaning "this is against the
 * reporting application's rules and the universal taxonomy has no name for it".
 * Forcing it into `integrity.*` would tell a jury the reporter alleged something
 * they did not.
 *
 * **`explicit_content` maps to the activity code, not the nudity code.**
 * `sexual_content.nudity` and `sexual_content.explicit_activity` are different
 * claims and Mention's UI offers one button for both. The stronger code is the
 * honest reading of what a reporter means by "explicit", and a jury that finds
 * only nudity will say so — whereas alleging nudity when explicit activity was
 * reported would understate the report and could route it to a lighter review.
 *
 * **The five `job`-only categories (#952) read as listing-accuracy claims, not
 * person-harm ones**, which is why three of them land in `commerce.*`/`integrity.*`
 * rather than `harassment.*`: `scam` is `integrity.scam` (an exact match — a
 * claim of intent to defraud). `discriminatory` is `hate.protected_targeting`,
 * the same code `hate_speech` uses — an employment listing that excludes a
 * protected class is that same allegation aimed at a job posting rather than a
 * post. `impersonation` is `integrity.impersonation` (exact match — a claim the
 * employer identity itself is fake). `already_filled` is `commerce.misleading_listing`:
 * the claim is that the listing no longer reflects reality, the same shape as a
 * marketplace listing for something no longer for sale. `duplicate` is
 * `integrity.spam`, matching how `spam` itself is mapped — a repeat posting is
 * that allegation aimed at a listing.
 */
export const REPORT_TAXONOMY_VERSION = '2026.07';

const CATEGORY_TO_ALLEGATION: Readonly<Record<ReportCategory, TaxonomyCode>> = Object.freeze({
  spam: 'integrity.spam',
  hate_speech: 'hate.protected_targeting',
  harassment: 'harassment.targeted_abuse',
  misinformation: 'other.policy_specific',
  explicit_content: 'sexual_content.explicit_activity',
  scam: 'integrity.scam',
  discriminatory: 'hate.protected_targeting',
  impersonation: 'integrity.impersonation',
  already_filled: 'commerce.misleading_listing',
  duplicate: 'integrity.spam',
  other: 'other.unclassifiable',
});

/**
 * The allegation codes for a report's categories, deduplicated and ORDERED.
 *
 * Order is not cosmetic. Ingress fingerprints the whole envelope to detect §10.5's
 * "same external id, different body", so a list whose order depended on how a
 * client happened to send its categories would turn a legitimate outbox retry into
 * a permanent 409 — days later, as a report silently stuck in a queue. Sorting
 * makes the same report produce the same bytes every time.
 */
export function allegationsForCategories(
  categories: readonly ReportCategory[],
): TaxonomyCode[] {
  const codes = new Set<TaxonomyCode>();
  for (const category of categories) {
    const code = CATEGORY_TO_ALLEGATION[category];
    // A category the map does not cover cannot silently become nothing: a report
    // with no allegation is not a report. `other.unclassifiable` is what the
    // universal taxonomy provides for exactly this.
    codes.add(code ?? 'other.unclassifiable');
  }
  return Array.from(codes).sort();
}
