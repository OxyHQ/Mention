import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, contractTest as test } from '../fixtures';

const require = createRequire(import.meta.url);
const runtimeDirectory = join(
  dirname(require.resolve('@oxy.so/bloom/package.json')),
  'assets/character-runtime',
);
const teal = {
  shape: 'rounded_head_two_ears',
  eyes: 'oval',
  color: 'teal',
  eyewear: 'none',
  accessory: 'none',
};
const lime = {
  shape: 'rounded_head_two_ears',
  eyes: 'clippo',
  color: 'lime',
  eyewear: 'none',
  accessory: 'bow',
  preset: 'lime_frog',
};
const bot = {
  id: '019e23ee-2d68-7000-8001-000000000081',
  username: 'eusebiobot',
  kind: 'bot',
  name: { displayName: 'Eusebio Agent' },
  character: teal,
};
const otherBot = {
  ...bot,
  id: '019e23ee-2d68-7000-8001-000000000082',
  username: 'brotivational-speakerbot',
  name: { displayName: 'Bro Agent' },
  character: lime,
};
const human = {
  id: '019e23ee-2d68-7000-8001-000000000083',
  username: 'humanfixture',
  kind: 'personal',
  name: { displayName: 'Human Photo' },
  avatar: 'https://media.mention.earth/agent-test-human.svg',
};
const remote = {
  ...human,
  id: '019e23ee-2d68-7000-8001-000000000084',
  username: 'remotefixture',
  kind: 'bot',
  name: { displayName: 'Remote Photo' },
  isFederated: true,
  instance: 'example.test',
};

// Observe the real runtime boundary without replacing rendering, scheduling or callbacks.
const audit = `
const registry = globalThis[Symbol.for('bloom.character.runtimes')];
const api = registry.get(import.meta.url), create = api.createAvatar;
const records = globalThis.__accountAvatarAudit = [];
api.createAvatar = async (canvas, props, callbacks) => {
 const entry={canvas,props,ready:0,errors:0,disposed:false};records.push(entry);
 const controller=await create(canvas,props,{...callbacks,onReady(){entry.ready++;callbacks.onReady?.()},onError(){entry.errors++;callbacks.onError?.()}});
 return {update(next){entry.props=next;controller.update(next)},dispose(){entry.disposed=true;controller.dispose()}};
};`;

test.beforeEach(async ({ page }) => {
  // The installed candidate package owns runtime bytes; the fixture never tests a mutable CDN revision.
  await page.route('**/bloom-character/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const relative = pathname.split('/bloom-character/')[1];
    if (!relative || relative.includes('..')) return route.abort();
    const bytes = await readFile(join(runtimeDirectory, relative));
    await route.fulfill({
      body: relative === 'runtime.mjs' ? Buffer.concat([bytes, Buffer.from(audit)]) : bytes,
      contentType: relative.endsWith('.mjs')
        ? 'text/javascript'
        : relative.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream',
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.route(human.avatar, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#46719b"/></svg>',
    }),
  );
  await page.route('https://api.oxy.so/profiles/username/**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(otherBot.username) ? otherBot : bot,
    }),
  );
  await page.route('https://api.oxy.so/profiles/search**', (route) => {
    const query = new URL(route.request().url()).searchParams.get('query');
    return route.fulfill({
      json: {
        data:
          query === 'groups'
            ? [human, remote]
            : [{ ...bot, character: query === 'changed' ? lime : teal }, human, remote],
        pagination: { hasMore: false },
      },
    });
  });
  await page.route('**/search/overview**', (route) => {
    const groups = new URL(route.request().url()).searchParams.get('q') === 'groups';
    return route.fulfill({
      json: {
        lanes: groups
          ? {
              feeds: {
                status: 'ok',
                items: [
                  {
                    id: 'agent-feed',
                    title: 'Agent feed',
                    memberProfiles: [bot],
                    memberAvatars: [],
                    memberCount: 1,
                  },
                ],
              },
              starterPacks: {
                status: 'ok',
                items: [
                  {
                    id: 'agent-pack',
                    name: 'Agent pack',
                    memberProfiles: [otherBot],
                    memberAvatars: [],
                    memberCount: 1,
                    useCount: 0,
                  },
                ],
              },
            }
          : {},
        pending: false,
      },
    });
  });
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({
      json: {
        items: [bot, otherBot, human, remote].map((user, index) => ({
          id: `019e23ee-2d68-7000-8000-${String(index + 181).padStart(12, '0')}`,
          user,
          authors: [],
          attachments: {},
          content: { text: `Stored avatar row ${index}` },
          metadata: {
            visibility: 'public',
            status: 'published',
            createdAt: '2026-10-01T12:00:00Z',
          },
          engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
          viewerState: { isOwner: false, isLiked: false, isBoosted: false, isSaved: false },
        })),
        hasMore: false,
      },
    }),
  );
});

async function visibleCharacters(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const records =
      (
        window as unknown as {
          __accountAvatarAudit?: {
            canvas: HTMLCanvasElement;
            props: { character: unknown };
            ready: number;
            errors: number;
            disposed: boolean;
          }[];
        }
      ).__accountAvatarAudit ?? [];
    return records
      .filter(
        (entry) =>
          !entry.disposed &&
          entry.canvas.isConnected &&
          entry.canvas.getBoundingClientRect().width > 0,
      )
      .map((entry) => ({
        character: entry.props.character,
        ready: entry.ready,
        errors: entry.errors,
        width: entry.canvas.width,
        png: entry.canvas.toDataURL(),
      }));
  });
}

async function decodedAvatarPixels(page: import('@playwright/test').Page, minimumWidth = 0) {
  const entries = (await visibleCharacters(page)).filter((entry) => entry.width >= minimumWidth);
  return page.evaluate(
    async (values) =>
      Promise.all(
        values.map(async (entry) => {
          const image = new Image();
          image.src = entry.png;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('PNG decode canvas unavailable');
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let alpha = 0,
            red = 0,
            green = 0,
            blue = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const weight = pixels[i + 3] / 255;
            alpha += weight;
            red += pixels[i] * weight;
            green += pixels[i + 1] * weight;
            blue += pixels[i + 2] * weight;
          }
          return {
            character: entry.character,
            alpha,
            red: red / alpha,
            green: green / alpha,
            blue: blue / alpha,
          };
        }),
      ),
    entries,
  );
}

async function expectPhotosLoaded(page: import('@playwright/test').Page) {
  await expect
    .poll(() =>
      page
        .locator(`img[src="${human.avatar}"]`)
        .evaluateAll(
          (images) =>
            images.filter(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth === 128,
            ).length,
        ),
    )
    .toBeGreaterThanOrEqual(2);
}

test('feed, profile and search retain stored agents while photos keep their image path', async ({
  page,
  candidate,
}) => {
  await page.goto('/');
  await expect(page.getByText('Stored avatar row 0', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await visibleCharacters(page)).filter((entry) => entry.ready > 0).length)
    .toBe(2);
  const initial = await visibleCharacters(page);
  expect(
    initial.every((entry) => entry.errors === 0 && entry.width > 0 && entry.png.length > 500),
  ).toBe(true);
  expect(JSON.stringify(initial)).toContain('teal');
  expect(JSON.stringify(initial)).toContain('lime');
  expect((await decodedAvatarPixels(page)).every((entry) => entry.alpha > 50)).toBe(true);
  await expectPhotosLoaded(page);
  await page.screenshot({ path: test.info().outputPath('feed-avatars.png') });
  // Changing route through browser history keeps the app/runtime instance alive.
  await page.evaluate(() => {
    history.pushState({}, '', '/@eusebiobot');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByTestId('profile-hero-content')).toBeVisible();
  await expect
    .poll(async () =>
      (await visibleCharacters(page)).some(
        (entry) =>
          entry.ready > 0 && entry.width >= 80 && JSON.stringify(entry.character).includes('teal'),
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await decodedAvatarPixels(page, 80)).some(
        (entry) => entry.alpha > 50 && entry.blue > entry.green * 0.5,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    history.pushState({}, '', '/@brotivational-speakerbot');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect
    .poll(async () =>
      (await visibleCharacters(page)).some(
        (entry) =>
          entry.ready > 0 && entry.width >= 80 && JSON.stringify(entry.character).includes('lime'),
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await decodedAvatarPixels(page, 80)).some(
        (entry) => entry.alpha > 50 && entry.blue < entry.green * 0.5,
      ),
    )
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath('profile-agent.png') });
  await page.evaluate(() => {
    history.pushState({}, '', '/search?q=agents');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  const input = page.getByPlaceholder('Search...', { exact: true });
  await expect(input).toBeVisible();
  await expect(page.getByText('Human Photo', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Remote Photo', { exact: true }).first()).toBeVisible();
  await expect
    .poll(
      async () =>
        (await visibleCharacters(page)).filter(
          (entry) => entry.ready > 0 && JSON.stringify(entry.character).includes('teal'),
        ).length,
    )
    .toBe(1);
  await expectPhotosLoaded(page);
  await expect
    .poll(async () =>
      (await decodedAvatarPixels(page)).some(
        (entry) => entry.alpha > 50 && entry.blue > entry.green * 0.5,
      ),
    )
    .toBe(true);
  await input.fill('changed');
  await input.press('Enter');
  await expect
    .poll(
      async () =>
        (await visibleCharacters(page)).filter(
          (entry) => entry.ready > 0 && JSON.stringify(entry.character).includes('lime'),
        ).length,
    )
    .toBe(1);
  await expect
    .poll(async () =>
      (await decodedAvatarPixels(page)).some(
        (entry) => entry.alpha > 50 && entry.blue < entry.green * 0.5,
      ),
    )
    .toBe(true);
  await expectPhotosLoaded(page);
  expect((await visibleCharacters(page)).every((entry) => entry.errors === 0)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('search-updated-agent.png') });
  await input.fill('groups');
  await input.press('Enter');
  await expect(page.getByTestId('feed-agent-feed')).toBeVisible();
  await expect(page.getByTestId('starterpack-agent-pack')).toBeVisible();
  await expect
    .poll(async () => (await visibleCharacters(page)).filter((entry) => entry.ready > 0).length)
    .toBe(2);
  expect((await decodedAvatarPixels(page)).every((entry) => entry.alpha > 50)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('member-agent-facepiles.png') });
  expect(candidate.scriptErrors).toEqual([]);
});

test('human profile photos keep tabs, zoom and the bundled fallback usable', async ({
  page,
  candidate,
}) => {
  const missingPhoto = 'https://media.mention.earth/agent-test-missing.jpg';
  await page.route(missingPhoto, (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.route('**/channels/*/writers**', (route) =>
    route.fulfill({ status: 404, json: { error: 'Writers are not public' } }),
  );
  await page.route('https://api.oxy.so/profiles/username/**', (route) => {
    const missing = new URL(route.request().url()).pathname.endsWith('missingphoto');
    const channel = new URL(route.request().url()).pathname.endsWith('channelphoto');
    return route.fulfill({
      json: {
        ...human,
        id: missing
          ? '019e23ee-2d68-7000-8001-000000000085'
          : channel
            ? '019e23ee-2d68-7000-8001-000000000086'
            : human.id,
        username: missing ? 'missingphoto' : channel ? 'channelphoto' : human.username,
        kind: channel ? 'channel' : human.kind,
        avatar: missing ? missingPhoto : human.avatar,
      },
    });
  });
  await page.goto(`/@${human.username}`);
  const avatar = page.getByLabel('Profile avatar', { exact: true });
  await expect(page.getByTestId('profile-sticky-tabs')).toBeVisible();
  await expect
    .poll(() =>
      avatar
        .locator('img')
        .evaluateAll((images) =>
          images.some(
            (image) =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth === 128,
          ),
        ),
    )
    .toBe(true);
  // Read the displayed photo, not merely its source prop or accessible name.
  const photoPng = await avatar.screenshot();
  const center = await page.evaluate(
    async (png) => {
      const image = new Image();
      image.src = png;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return [...context.getImageData(image.width >> 1, image.height >> 1, 1, 1).data];
    },
    `data:image/png;base64,${photoPng.toString('base64')}`,
  );
  expect(center).toEqual([70, 113, 155, 255]);
  const geometry = await avatar.evaluate((element) => {
    const image = element.querySelector('img')!;
    return {
      photo: image.getBoundingClientRect().width,
      frame: element.getBoundingClientRect().width,
    };
  });
  expect(geometry).toEqual({ photo: 82, frame: 90 });
  await avatar.click();
  const closeGallery = page.getByRole('button', { name: 'Close media viewer', exact: true });
  await expect(closeGallery).toBeVisible();
  // This control is the full-screen backdrop, whose center is covered by the photo.
  await page.keyboard.press('Escape');
  await expect(closeGallery).not.toBeVisible();
  const mediaTab = page.getByRole('tab', { name: 'Media', exact: true });
  await mediaTab.focus();
  await page.keyboard.press('Enter');
  await expect(mediaTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('profile-sticky-tabs')).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, '', '/@missingphoto');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByTestId('profile-sticky-tabs')).toBeVisible();
  await expect
    .poll(() =>
      avatar
        .locator('img')
        .evaluateAll((images) =>
          images.some(
            (image) =>
              image instanceof HTMLImageElement &&
              image.src.includes('default-avatar.') &&
              image.complete &&
              image.naturalWidth === 400,
          ),
        ),
    )
    .toBe(true);
  await expect(avatar).toHaveAttribute('aria-disabled', 'true');
  await expect(closeGallery).not.toBeVisible();
  await expect(page.getByText('Something went wrong', { exact: true })).not.toBeVisible();
  await test.info().attach('photo-profile-agent-readiness', {
    body: JSON.stringify(
      (await visibleCharacters(page)).map(({ character, ready, errors, width }) => ({
        character,
        ready,
        errors,
        width,
      })),
    ),
    contentType: 'application/json',
  });
  await page.screenshot({ path: test.info().outputPath('profile-photo-fallback.png') });
  await page.evaluate(() => {
    history.pushState({}, '', '/@channelphoto');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect
    .poll(() =>
      avatar.evaluate((element) => {
        const image = element.querySelector('img');
        return image?.complete && image.naturalWidth === 128
          ? {
              photo: image.getBoundingClientRect().width,
              frame: element.getBoundingClientRect().width,
            }
          : null;
      }),
    )
    .toEqual({ photo: 90, frame: 96 });
  await page.screenshot({ path: test.info().outputPath('channel-photo-frame.png') });
  expect(candidate.scriptErrors).toEqual([]);
});
