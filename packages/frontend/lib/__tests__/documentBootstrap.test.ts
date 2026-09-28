/**
 * @jest-environment jsdom
 */
import { __documentBootstrapForTests, bootstrapProfileFor } from '@/lib/documentBootstrap.web';

// The real identity normalizer, through core's CommonJS build (Jest cannot load
// the ESM entry the app resolves). `jest.mock` is hoisted above the import.
jest.mock('@oxy.so/core', () => jest.requireActual('../../../../node_modules/@oxy.so/core/dist/cjs/utils/userIdentity.js'));

function serve(json: string | null): void {
  document.getElementById('mention-bootstrap')?.remove();
  if (json !== null) {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = 'mention-bootstrap';
    element.textContent = json;
    document.head.appendChild(element);
  }
  __documentBootstrapForTests.reset();
}

const nate = { id: 'oxy-nate', username: 'nate', name: { displayName: 'Nate' } };

describe('bootstrapProfileFor', () => {
  afterEach(() => serve(null));

  it('returns the served profile for the handle the document was served for', () => {
    serve(JSON.stringify({ profile: { handle: 'Nate', data: nate } }));
    expect(bootstrapProfileFor('@nate')).toEqual(expect.objectContaining({ id: 'oxy-nate', username: 'nate' }));
  });

  it('returns nothing for any other handle', () => {
    serve(JSON.stringify({ profile: { handle: 'nate', data: nate } }));
    expect(bootstrapProfileFor('ada')).toBeNull();
  });

  it('refuses a payload whose username the route does not own and no proven alias names', () => {
    serve(JSON.stringify({ profile: { handle: 'nate', data: { ...nate, username: 'someone-else' } } }));
    expect(bootstrapProfileFor('nate')).toBeNull();
  });

  it('is absent without a block, with a malformed one, or without an id', () => {
    serve(null);
    expect(bootstrapProfileFor('nate')).toBeNull();
    serve('{not json');
    expect(bootstrapProfileFor('nate')).toBeNull();
    serve(JSON.stringify({ profile: { handle: 'nate', data: { username: 'nate' } } }));
    expect(bootstrapProfileFor('nate')).toBeNull();
  });
});

describe('bootstrapProfileFor on native', () => {
  it('has no document, so never a profile', () => {
    // The explicit file: the platform default Metro serves native builds.
    const native = jest.requireActual<typeof import('@/lib/documentBootstrap')>('../documentBootstrap.ts');
    expect(native.bootstrapProfileFor('nate')).toBeNull();
  });
});
