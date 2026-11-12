import { expect, contractTest as test } from '../fixtures';
import { arrangeVideoPost, POST_ID } from '../fixtures/videoPlayback';
import { installReplySession } from '../fixtures/replySession';

test.afterEach(({ candidate }) => {
  expect(candidate.scriptErrors).toEqual([]);
});

test('compact reply on mobile keeps one input from rest to focus and maximizes exact draft', async ({
  page,
  context,
  candidate,
}) => {
  expect(candidate.scriptErrors).toEqual([]);
  await installReplySession(context);
  await arrangeVideoPost(page, 'mp4');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${POST_ID}`);
  const post = page.getByTestId('post-screen');
  const input = post.getByRole('textbox');
  await expect(input).toBeVisible();
  const original = await input.elementHandle();
  await input.fill('A reply in the compact composer');
  await expect(post.getByTestId('compact-reply-submit')).toBeVisible();
  await page.waitForTimeout(400);
  expect(await input.evaluate((node, old) => node === old, original)).toBe(true);
  await input.press('Tab');
  await expect(post.getByTestId('compact-reply-maximize')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(post.getByTestId('compact-reply-image')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(post.getByTestId('compact-reply-gif')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(post.getByTestId('compact-reply-submit')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(post.getByTestId('compact-reply-submit')).toBeVisible();
  const text = `  <literal> ${'hello '.repeat(20)}\n  keep spaces  `;
  await input.fill(text);
  await post.getByTestId('compact-reply-maximize').click();
  await expect(page).toHaveURL(/compose\?replyToPostId=/);
  await expect(page.getByRole('textbox').filter({ visible: true }).first()).toHaveValue(text);
  await expect(page.getByTestId('compose-submit')).toBeVisible();
});

test('compact limit and one outer viewport keep Bloom actions fixed', async ({
  page,
  context,
  candidate,
}) => {
  expect(candidate.scriptErrors).toEqual([]);
  await installReplySession(context);
  await arrangeVideoPost(page, 'mp4');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${POST_ID}`);
  const post = page.getByTestId('post-screen');
  const input = post.getByRole('textbox');
  await expect(input).toBeVisible();
  await input.fill('a'.repeat(250));
  await input.press('End');
  await input.press('b');
  await expect(input).toHaveValue('a'.repeat(250));
  const maximize = post.getByTestId('compact-reply-maximize');
  const originalMaximize = await maximize.elementHandle();
  const attention = maximize.locator('[data-bloom-glyph-attention]');
  await expect(attention).toHaveCSS('animation-name', 'bloom-glyph-attention-a');
  await input.press('c');
  await expect(attention).toHaveCSS('animation-name', 'bloom-glyph-attention-b');
  expect(await maximize.evaluate((node, original) => node === original, originalMaximize)).toBe(
    true,
  );
  await expect(input).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await input.press('d');
  await expect(attention).toHaveCSS('animation-name', 'none');
  await expect(input).toHaveValue('a'.repeat(250));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await input.fill('line\n'.repeat(50));
  await expect(input).toHaveValue('line\n'.repeat(50));
  await page.waitForTimeout(400);
  const before = await post.getByTestId('compact-reply-toolbar').boundingBox();
  const metrics = await input.evaluate((node) => {
    const e = node as HTMLTextAreaElement;
    return {
      client: e.clientHeight,
      scroll: e.scrollHeight,
      overflow: getComputedStyle(e).overflowY,
    };
  });
  expect(metrics.overflow).toBe('hidden');
  expect(metrics.scroll - metrics.client).toBeLessThanOrEqual(2);
  const scroll = post.getByTestId('compact-reply-scroll');
  await scroll.evaluate((node) => {
    const nodes = [node, ...node.querySelectorAll('*')];
    const viewport = nodes.find(
      (e) =>
        e.scrollHeight > e.clientHeight + 2 &&
        ['auto', 'scroll'].includes(getComputedStyle(e).overflowY),
    );
    if (!viewport) throw new Error('No outer Bloom viewport');
    viewport.scrollTop = viewport.scrollHeight;
  });
  await expect(post.getByTestId('compact-reply-submit')).toBeVisible();
  const after = await post.getByTestId('compact-reply-toolbar').boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  expect(after!.y + after!.height).toBeLessThanOrEqual(844);
});

test('committed Back flushes edits made after expanding before the autosave debounce', async ({
  page,
  context,
  candidate,
}) => {
  expect(candidate.scriptErrors).toEqual([]);
  await installReplySession(context);
  await arrangeVideoPost(page, 'mp4');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${POST_ID}`);
  const input = page.getByTestId('post-screen').getByRole('textbox');
  await input.fill('Original compact draft');
  await page.getByTestId('compact-reply-maximize').click();
  const full = page.getByRole('textbox').filter({ visible: true }).first();
  await expect(full).toHaveValue('Original compact draft');
  await expect(page.getByTestId('compose-submit')).toBeEnabled();
  const edited = 'Changed immediately before committed Back';
  await full.fill(edited);
  const started = Date.now();
  await page.goBack();
  expect(Date.now() - started).toBeLessThan(2000);
  await expect
    .poll(() =>
      page.evaluate(
        (value) =>
          Object.keys(localStorage)
            .filter((key) => key.includes('mention_drafts'))
            .some((key) => {
              try {
                return JSON.parse(localStorage.getItem(key) ?? '[]').some(
                  (draft: { postContent?: string }) => draft.postContent === value,
                );
              } catch {
                return false;
              }
            }),
        edited,
      ),
    )
    .toBe(true);
});

test('full composer keeps its empty 25000 ring next to Post and accepts 252 characters', async ({
  page,
  context,
  candidate,
}) => {
  expect(candidate.scriptErrors).toEqual([]);
  await installReplySession(context);
  await arrangeVideoPost(page, 'mp4');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${POST_ID}`);
  await page.getByTestId('compact-reply-maximize').click();
  const full = page.getByRole('textbox').filter({ visible: true }).first();
  await expect(full).toHaveValue('');
  const ring = page.getByRole('meter').filter({ visible: true });
  await expect(ring).toHaveAttribute('aria-valuemax', '25000');
  await expect(ring).toHaveAttribute('aria-valuenow', '0');
  await full.fill('x'.repeat(252));
  await expect(full).toHaveValue('x'.repeat(252));
  await expect(ring).toHaveAttribute('aria-valuenow', '252');
});

test('GIF picker attaches its durable id, maximizes it and preserves edits on immediate Back', async ({
  page,
  context,
  candidate,
}) => {
  expect(candidate.scriptErrors).toEqual([]);
  await installReplySession(context);
  await arrangeVideoPost(page, 'mp4');
  await page.setViewportSize({ width: 390, height: 844 });
  const media = 'https://media.mention.earth/playback-regression/clip.mp4';
  let imports = 0;
  await page.route('**/gifs/trending**', (r) =>
    r.fulfill({
      json: {
        gifs: [
          {
            id: 'gif-choice',
            klipyId: 'fixture-klipy',
            slug: 'fixture',
            title: 'Fixture GIF',
            mp4Url: media,
            previewUrl: media,
            width: 90,
            height: 160,
          },
        ],
        hasNext: false,
        page: 1,
      },
    }),
  );
  await page.route('**/gifs/use', (r) => {
    imports++;
    return r.fulfill({ json: { fileId: 'private-gif-file', gifId: 'fixture-gif', mp4Url: media } });
  });
  await page.route('**/assets/batch-access', (r) =>
    r.fulfill({
      json: {
        results: {
          'private-gif-file': {
            allowed: true,
            url: media,
            mime: 'video/mp4',
            visibility: 'private',
          },
        },
      },
    }),
  );
  await page.goto(`/p/${POST_ID}`);
  await page.getByTestId('compact-reply-scroll').getByTestId('compact-reply-gif').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await sheet.locator('video').first().click();
  await expect(sheet).not.toBeVisible();
  await expect(page.getByTestId('compact-reply-submit')).toBeEnabled();
  await page.getByTestId('compact-reply-maximize').click();
  await expect(page.getByTestId('compose-submit')).toBeEnabled();
  const full = page.getByRole('textbox').filter({ visible: true }).first();
  await full.fill('GIF draft after expanding');
  await page.goBack();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => k.includes('mention_drafts'))
          .some((k) => {
            try {
              return JSON.parse(localStorage.getItem(k) ?? '[]').some(
                (d: { postContent?: string; mediaIds?: Array<{ id: string; type: string }> }) =>
                  d.postContent === 'GIF draft after expanding' &&
                  d.mediaIds?.some(
                    (m: { id: string; type: string }) =>
                      m.id === 'private-gif-file' && m.type === 'gif',
                  ),
              );
            } catch {
              return false;
            }
          }),
      ),
    )
    .toBe(true);
  expect(imports).toBe(1);
});

for (const motion of ['no-preference', 'reduce'] as const) {
  test(`empty composer focus and blur keep the input within its settled trajectory (${motion})`, async ({
    page,
    context,
    candidate,
  }) => {
    expect(candidate.scriptErrors).toEqual([]);
    await installReplySession(context);
    await arrangeVideoPost(page, 'mp4');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: motion });
    await page.goto(`/p/${POST_ID}`);
    const input = page.getByTestId('post-screen').getByRole('textbox');
    await expect(input).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect
      .poll(
        async () =>
          (await page.getByTestId('post-reply-navigation-action-content').boundingBox())?.height,
      )
      .toBe(56);
    const all: Record<string, unknown> = {};
    for (const focused of [true, false]) {
      const frames = await input.evaluate(
        (node: HTMLTextAreaElement, focus) =>
          new Promise<
            Array<{
              y: number;
              height: number;
              connected: boolean;
              viewport: number;
              windowY: number;
            }>
          >((resolve) => {
            const read = () => ({
              y: node.getBoundingClientRect().y,
              height: node.getBoundingClientRect().height,
              connected: node.isConnected,
              viewport: window.innerHeight,
              windowY: window.scrollY,
            });
            const rows = [read()];
            const started = performance.now();
            if (focus) node.focus();
            else node.blur();
            const sample = () => {
              rows.push(read());
              if (performance.now() - started < 800) requestAnimationFrame(sample);
              else resolve(rows);
            };
            requestAnimationFrame(sample);
          }),
        focused,
      );
      all[focused ? 'focus' : 'blur'] = frames;
    }
    await test.info().attach('composer-focus-trajectory', {
      body: JSON.stringify(all),
      contentType: 'application/json',
    });
    for (const rows of Object.values(all) as Array<
      Array<{ y: number; height: number; connected: boolean; viewport: number; windowY: number }>
    >) {
      expect(
        rows.every(
          (row) =>
            row.connected &&
            row.height > 0 &&
            row.viewport === 844 &&
            row.windowY === rows[0].windowY,
        ),
      ).toBe(true);
      const endpoints = [rows[0].y, rows.at(-1)!.y];
      expect(Math.min(...rows.map((row) => row.y))).toBeGreaterThanOrEqual(
        Math.min(...endpoints) - 2,
      );
      expect(Math.max(...rows.map((row) => row.y))).toBeLessThanOrEqual(Math.max(...endpoints) + 2);
    }
  });
}
