# Mention final registry catalog and bundle follow-up

Source commits `57e0452ea` and `a96522c454`, following registry source `4ec3f311` and proof `513e1bdf7`. The separate imports fixture belongs to `bcc3274ad` and its own proof.

CI 37163722838 identified five workspace catalog drifts and one total bundle ceiling violation. Five manifest references now use `catalog:` without changing their resolved versions. The obsolete MCP 1.0/contracts exception is removed; the full workspace validator remains enforced. Bun 1.3.14 is explicitly placed first in PATH. The lock's resolved packages section is byte-identical to 513e1bdf7 and 5,180 installed SDK file comparisons still pass.

The first workspace invocation used host Bun 1.4.2 and failed the version guard. The next parallel workspace invocation found the obsolete exception and interrupted sibling checks (exit130). Both failures are retained. Final `bun run check:workspace` and `bun run check:types` exit0; types includes frontend lint with 205 warnings, zero errors. These results do not claim warning-free source.

## Measured bundle allowance

Authenticated CI artifact 11288159569 and the fresh local `build:analyze` agree exactly on total 21,676,483 bytes, JavaScript 17,043,597, initial JavaScript 7,178,371 and fonts 2,013,156. Local compressor output differs slightly across environments; it is not claimed byte-identical to CI.

Against CI's base report, total grew 372,653 bytes, JavaScript 339,559 and other assets 33,094. Font bytes are unchanged. Initial gzip grew 12,516 bytes and remains below its existing ceiling. Isolated gzip source attribution shows Bloom +79,980, contracts +12,774, core +6,217 and Services +5,228; these source figures are not additive bundle bytes. The five deferred-source constraints still pass.

Bloom 7.1.2 is the measured published compatible line: current Mention uses EdgeScrim and SCRIM_TAIL_RATIO absent from 6.2.1. No application UI features are removed. Source-map census records one ESM root for each Oxy dependency (Bloom871, Services211, core113, contracts73, protocol18); no CommonJS copy or conflicting content for a package-relative source is present. Empty-source entries explain differences from the analyzer's content-only attribution counts.

Only totalBytes changes from 21,495,808 (20.50MiB) to 21,757,952 (20.75MiB), leaving 81,469 bytes of headroom, less than the old baseline's 191,978. All five specific ceilings, performance target, analyzer and deferred-source rules are unchanged. This is an explicit measured dependency-adoption allowance, not a claim of performance improvement. Remote CI and browser/runtime restoration remain pending.

The budget source commit also carries three retained logs from the separate imports fixture proof, after a coordinated-index race; no source was lost. Its predecessor budget commit had identical budget bytes. Final analyzer with `--ci` exits0.
