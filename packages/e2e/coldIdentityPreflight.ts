import { loadColdEvidence } from './coldIdentityEvidence';

// No HTTP preflight: both database absence reports precede every browser request.
export default function coldIdentityPreflight(): void { loadColdEvidence(); }
