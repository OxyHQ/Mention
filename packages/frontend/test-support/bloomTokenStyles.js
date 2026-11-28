/**
 * `createTokenStyles` and `useColorTokens` of `@oxy.so/bloom/theme`, for suites
 * that mock that module: every colour token reads as one flat colour.
 *
 *   jest.mock('@oxy.so/bloom/theme', () => ({
 *     ...require('@/test-support/bloomTokenStyles'),
 *     useTheme: () => ...,
 *   }));
 */
const tokens = new Proxy({}, { get: () => '#000' });

module.exports = {
  useColorTokens: () => tokens,
  createTokenStyles: (build) => () => build(tokens),
};
