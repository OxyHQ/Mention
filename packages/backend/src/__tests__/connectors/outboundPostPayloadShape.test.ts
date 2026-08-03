import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every outbound `post.create` / `post.update` event must carry the post
 * DOCUMENT, never a hand-picked list of its fields.
 *
 * ## Why this is a static check and not a behavioural one
 *
 * `LocalPostEventPayload` (the seam's type, in `@oxyhq/federation`) names fewer
 * fields than the Note builder reads: `metadata.isSensitive` becomes the Note's
 * `sensitive` flag and `quoteOf` becomes its quote fields, and neither is on the
 * type. Passing the document works because the extra properties ride along at
 * runtime; passing an object literal type-checks just as well and silently drops
 * them. So the compiler cannot tell the two apart, and the damage is invisible
 * at the call site: a sensitive reply federates UNMARKED and a quote reply
 * federates with no quote, with no error anywhere.
 *
 * Both shipped that way — `feed.controller.federateReply` and `updatePost` —
 * until the batch-federation work found it. A behavioural test would pin the two
 * fields that are known to be missing today; this pins the RULE, so the next
 * field the builder learns to read cannot go missing at a call site nobody
 * revisited.
 *
 * ## What keeps this check honest
 *
 * A source scan that silently stops finding anything reads as a pass, so the
 * count of inspected sites is asserted against a floor. The floor is deliberately
 * a minimum rather than an exact number: a new legitimate call site must not
 * fail the build, but a traversal that breaks must.
 */

const SOURCE_ROOT = path.resolve(__dirname, '../..');

/** The event kinds whose payload is a post. */
const POST_PAYLOAD_KINDS = ["kind: 'post.create'", "kind: 'post.update'"];

/**
 * The smallest number of construction sites this scan may find and still be
 * believed. Three exist today (the connector registry's own `federateNewPost`,
 * the reply path, and the edit path).
 */
const MINIMUM_SITES = 3;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface PayloadSite {
  file: string;
  line: number;
  /** The source line assigning the event's `post` property. */
  postLine: string;
}

/**
 * Every `post.create` / `post.update` event literal in the tree, paired with the
 * `post:` line that follows it. Comment lines between the two are skipped, since
 * these call sites are heavily commented.
 */
function findPayloadSites(): PayloadSite[] {
  const sites: PayloadSite[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!POST_PAYLOAD_KINDS.some((kind) => line.includes(kind))) return;
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const candidate = lines[cursor].trim();
        if (candidate === '' || candidate.startsWith('//') || candidate.startsWith('*')) continue;
        sites.push({ file: path.relative(SOURCE_ROOT, file), line: index + 1, postLine: candidate });
        break;
      }
    });
  }
  return sites;
}

describe('outbound post payloads', () => {
  it('scans enough call sites to be worth believing', () => {
    expect(findPayloadSites().length).toBeGreaterThanOrEqual(MINIMUM_SITES);
  });

  it('hands the post DOCUMENT to every post.create / post.update event', () => {
    const handBuilt = findPayloadSites().filter((site) => {
      // `post,` (shorthand) and `post: <identifier>,` both pass a value the
      // caller already holds. `post: {` opens a literal, which is the shape that
      // drops whatever it does not name. Print the whole matched line on
      // failure — a truncated capture is how a scan ends up asserting nothing.
      if (!site.postLine.startsWith('post')) return false;
      return /^post:\s*\{/.test(site.postLine);
    });

    expect(
      handBuilt.map((site) => `${site.file}:${site.line} -> ${site.postLine}`),
    ).toEqual([]);
  });

  it('finds a `post:` line for every event it scanned', () => {
    // If the line following an event literal is not the payload at all, the check
    // above inspects the wrong text and passes for the wrong reason.
    const misread = findPayloadSites().filter((site) => !site.postLine.startsWith('post'));

    expect(misread.map((site) => `${site.file}:${site.line} -> ${site.postLine}`)).toEqual([]);
  });
});
