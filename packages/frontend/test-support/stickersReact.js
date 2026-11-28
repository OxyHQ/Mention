/**
 * Jest stand-in for `@oxy.so/stickers/react` (mapped in package.json).
 *
 * The REAL module, with one difference: `useSticker` outside a
 * `StickersProvider` answers "not resolved" instead of throwing. Almost every
 * screen draws an empty state and every empty state may name a sticker, so
 * without this each screen test would have to mount the provider to test
 * something else entirely. A test that is about the sticker mounts the real
 * provider (see `components/common/__tests__/emptyStateSticker.test.tsx`), and
 * then this is the real hook.
 */
const actual = require('../../../node_modules/@oxy.so/stickers/dist/cjs/react.js');

const NOT_RESOLVED = { data: undefined, isLoading: false, isSuccess: false, isError: false };

function useSticker(id) {
  let hasProvider = true;
  try {
    actual.useStickersClient();
  } catch {
    hasProvider = false;
  }
  // The branch is fixed for a component's whole life (a provider does not
  // appear under a mounted child), so hook order stays stable.
  return hasProvider ? actual.useSticker(id) : NOT_RESOLVED;
}

module.exports = { ...actual, useSticker };
