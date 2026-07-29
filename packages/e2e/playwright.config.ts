import { defineConfig, devices } from '@playwright/test';
import { APP_ORIGIN } from './environment';

/**
 * Chromium-only, on purpose. WebKit doubles the browser download and the wall
 * clock of a step that sits directly in front of a production promotion; it is
 * worth adding once the gate has proven itself, not before.
 */
export default defineConfig({
  testDir: './tests',
  // The suite talks to production over the network, so wall clock is dominated
  // by real latency rather than CPU. Running the flows concurrently keeps the
  // whole step well under a minute.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry, and no more. A live-network gate in front of a production
  // promotion must not turn a dropped connection into a blocked release — but a
  // real regression fails both attempts, and Playwright still reports anything
  // that only passed on the retry as flaky, which is a signal worth reading.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list']],
  // Generous, because AGENTS.md documents cold-boot session restore taking
  // 5-25s on web. Every wait below is still on a real condition; this only
  // bounds how long a real condition is allowed to take.
  timeout: 90_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: APP_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // AGENTS.md: a backgrounded tab pauses rAF and freezes CSS transitions,
    // which reads as "the app never rendered". Headless Chromium always treats
    // its page as foregrounded, so the readings here are real.
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Wide enough for the expanded sidebar: `useIsSideBarExpanded` needs
        // >=1300px before nav items render their labels, and the navigation
        // flow drives the app through those labels.
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
      },
    },
  ],
});
