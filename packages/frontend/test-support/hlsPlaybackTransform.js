// Keep Expo's normal transform while executing selected lazy imports in Jest's
// VM. Production still uses Metro's asynchronous chunks.
const [babelJest, options] = require('jest-expo/jest-preset').transform['\\.[jt]sx?$'];
module.exports = require(babelJest).createTransformer({
  ...options,
  plugins: [require.resolve('./perfDynamicImport')],
});
