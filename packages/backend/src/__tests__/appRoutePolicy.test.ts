import { describe, expect, it } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROUTE_FIRST_SEGMENTS, appRoutePolicy } from '../services/webshell/appRoutePolicy';

const APP_DIR = join(import.meta.dir, '../../../frontend/app');

/** Every first URL segment the app's file routes start with (route groups removed). */
function appFirstSegments(dir: string): Set<string> {
  const segments = new Set<string>();
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry.startsWith('_') || entry.startsWith('+')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (/^\(.+\)$/.test(entry)) {
        for (const segment of appFirstSegments(path)) segments.add(segment);
      } else {
        segments.add(entry);
      }
      continue;
    }
    const name = entry.replace(/(\.web|\.native|\.ios|\.android)?\.tsx?$/, '');
    if (name === entry || name === 'index') continue;
    segments.add(name);
  }
  return segments;
}

describe('apex app route policy', () => {
  it("names every first segment of the app's routes, so no page starts life as a 404", () => {
    const fromApp = [...appFirstSegments(APP_DIR)].filter((segment) => !segment.startsWith('['));
    expect([...APP_ROUTE_FIRST_SEGMENTS].sort()).toEqual(fromApp.sort());
  });

  it('serves a path no route answers as a real 404', () => {
    expect(appRoutePolicy('/random-garbage-xyz')).toEqual({ status: 404, noindex: true });
    expect(appRoutePolicy('/nodeinfo/2.1')).toEqual({ status: 404, noindex: true });
    expect(appRoutePolicy('/index.html')).toEqual({ status: 404, noindex: true });
  });

  it('leaves the homepage, profiles and content routes to the app', () => {
    for (const path of [
      '/',
      '/@nate/media',
      '/explore',
      '/t/cats',
      '/starter-packs/1',
      '/watch/1',
    ]) {
      expect(appRoutePolicy(path)).toEqual({ status: 200, noindex: false });
    }
  });

  it('marks signed-in tools, forms and lists about a post noindex', () => {
    for (const path of [
      '/settings',
      '/settings/privacy',
      '/search',
      '/compose',
      '/notifications',
      '/lists/create',
      '/feeds/1/edit',
      '/jobs/1/apply',
      '/p/1/quotes',
      '/c/news/settings',
    ]) {
      expect(appRoutePolicy(path)).toEqual({ status: 200, noindex: true });
    }
  });
});
