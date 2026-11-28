import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { authorizeInlineScripts, inlineScriptHashes } from '../services/webshell/webShellDocument';

/**
 * The theme prepaint is the one inline script the app's document carries. The
 * page's `script-src` has no `'unsafe-inline'`, so it runs only when its exact
 * bytes are authorized — by a hash read from the document itself.
 */

const SCRIPT =
  "(function(c){document.documentElement.setAttribute('data-bloom-theme-mode','dark')})({})";
const DOCUMENT = `<html><head><style data-bloom-theme-bootstrap>:root{}</style><script data-bloom-theme-bootstrap>${SCRIPT}</script></head></html>`;
const HASH = `'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'`;

function response(policy?: string) {
  const headers = new Map<string, string>();
  if (policy) headers.set('Content-Security-Policy', policy);
  return {
    headers,
    getHeader: (name: string) => headers.get(name),
    setHeader: (name: string, value: string) => headers.set(name, value),
  };
}

describe('the theme prepaint under the CSP', () => {
  it("hashes the document's own prepaint script, and nothing else", () => {
    expect(inlineScriptHashes(DOCUMENT)).toEqual([HASH]);
    expect(inlineScriptHashes('<html><script src="/a.js"></script></html>')).toEqual([]);
  });

  it('adds the hash to script-src only, once', () => {
    const res = response(
      "default-src 'self';script-src 'self' https://js.stripe.com;script-src-attr 'none'",
    );
    authorizeInlineScripts(res, [HASH]);
    authorizeInlineScripts(res, [HASH]);
    expect(res.headers.get('Content-Security-Policy')).toBe(
      `default-src 'self';script-src 'self' https://js.stripe.com ${HASH};script-src-attr 'none'`,
    );
  });

  it('never invents a policy, and never adds unsafe-inline', () => {
    const none = response();
    authorizeInlineScripts(none, [HASH]);
    expect(none.headers.has('Content-Security-Policy')).toBe(false);

    const res = response("script-src 'self'");
    authorizeInlineScripts(res, []);
    expect(res.headers.get('Content-Security-Policy')).toBe("script-src 'self'");
    expect(res.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
  });
});
