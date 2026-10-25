/**
 * Jest stand-in for `@oxy.so/bloom/surfaces` (mapped in package.json).
 *
 * Bloom resolves that subpath to untranspiled source whose Dialog pulls in
 * reanimated/worklets, which Jest cannot load — so every module that presents a
 * sheet (`utils/sheet`), a menu or a confirm would fail to LOAD. Same reason as
 * `bloomScreen.js` beside it.
 *
 * Nothing is drawn: each call answers as a surface the reader closed without
 * choosing would. A test that needs what was presented mocks the caller
 * (`@/utils/sheet`, `@/components/common/ActionMenu`) or this module itself; its
 * own `jest.mock` takes precedence.
 */
const React = require('react');

const closed = () => Promise.resolve(undefined);
const noop = () => {};

const SurfaceHost = () => null;
const SurfaceProvider = ({ children }) => React.createElement(React.Fragment, null, children);

module.exports = {
  SurfaceHost,
  SurfaceProvider,
  present: closed,
  dismiss: noop,
  dismissById: noop,
  dismissToRoot: noop,
  dismissAll: noop,
  alert: closed,
  confirm: () => Promise.resolve(false),
  confirmWithSuppression: () => Promise.resolve({ confirmed: false, suppressed: false }),
  prompt: closed,
  surfaces: {
    present: closed,
    dismiss: noop,
    dismissById: noop,
    dismissToRoot: noop,
    dismissAll: noop,
    alert: closed,
    confirm: () => Promise.resolve(false),
    prompt: closed,
  },
  useSurface: () => ({ dismiss: noop, present: closed }),
};
