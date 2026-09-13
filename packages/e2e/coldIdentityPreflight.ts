import { APP_ORIGIN, CANDIDATE_ORIGIN } from './environment';
import { loadColdEvidence, validateColdAppOrigin } from './coldIdentityEvidence';

// No HTTP preflight: both database absence reports precede every browser request.
export default function coldIdentityPreflight(): void {
  validateColdAppOrigin(CANDIDATE_ORIGIN, APP_ORIGIN);
  loadColdEvidence();
}
