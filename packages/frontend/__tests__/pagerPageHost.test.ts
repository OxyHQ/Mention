import fs from 'node:fs';
import path from 'node:path';

/**
 * The tab pager's page hosts (react-native-pager-view 9, patched: patches/README.md). Compose's
 * pager prefetches the page past the ones it keeps ahead of a scroll and attaches that page's host
 * before it lays it out or draws it. Shown there, the page sat at the window's origin, and Bloom's
 * lens, which draws a header control's glass in a window overlay at the control's place, drew
 * Home's header over Notifications (Pixel 8a: Profile, then Notifications). No JS test can see a
 * native view's visibility, so the installed pager source is the gate: the patch must be applied.
 */
const source = fs
  .readFileSync(
    path.join(
      path.dirname(require.resolve('react-native-pager-view/package.json')),
      'android/src/main/java/com/reactnativepagerview/ComposePagerView.kt',
    ),
    'utf8',
  )
  // Kotlin without its comments: a comment that names a guard must not satisfy the gate.
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

/** The braced block that opens after the first match of `start`. */
function block(start: RegExp): string {
  const at = source.search(start);
  if (at < 0) throw new Error(`${start} not found`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`${start} has no closing brace`);
}

const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('the tab pager shows a page only once Compose has placed it', () => {
  const container = block(/private inner class PageContainer\(/);

  it('a page host starts invisible', () => {
    expect(flat(container)).toMatch(/init \{ visibility = View\.INVISIBLE \}/);
  });

  it('a page host shows when it is laid out at a size, which Compose gives it only where it places it', () => {
    expect(flat(container)).toMatch(
      /override fun onLayout\([^)]*\) \{ visibility = if \(right > left && bottom > top\) View\.VISIBLE else View\.INVISIBLE/,
    );
  });

  it('every page is hosted in a PageContainer, created afresh: a page that leaves the window is released with its host', () => {
    const host = flat(block(/private fun PageHost\(/));
    expect(host).toMatch(/factory = \{ context -> PageContainer\(context\)/);
    // Without onReset the view is not reused: a host never comes back holding a stale layout.
    expect(host).not.toMatch(/onReset/);
  });
});
