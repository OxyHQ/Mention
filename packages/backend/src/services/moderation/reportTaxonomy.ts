import type { TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import { ReportCategory } from '../../models/Report.model';

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
 */
export const REPORT_TAXONOMY_VERSION = '2026.07';

const CATEGORY_TO_ALLEGATION: Readonly<Partial<Record<string, TaxonomyCode>>> = Object.freeze({
  [ReportCategory.SPAM]: 'integrity.spam',
  [ReportCategory.HATE_SPEECH]: 'hate.protected_targeting',
  [ReportCategory.HARASSMENT]: 'harassment.targeted_abuse',
  [ReportCategory.MISINFORMATION]: 'other.policy_specific',
  [ReportCategory.EXPLICIT_CONTENT]: 'sexual_content.explicit_activity',
  [ReportCategory.OTHER]: 'other.unclassifiable',
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
/**
 * Takes `readonly string[]` rather than `readonly ReportCategory[]` because the
 * shared package hands categories through as it received them — it has no opinion
 * about any application's enum. Widening here is honest rather than lossy: the
 * body below already treats an uncovered category as `other.unclassifiable`, so a
 * string outside the enum takes the path that was always written for it. The
 * alternative — casting at the boundary — would type-check while silently
 * asserting something untrue about the value.
 */
export function allegationsForCategories(
  categories: readonly string[],
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
