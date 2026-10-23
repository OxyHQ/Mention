// Keep Expo's normal transform; only make this web hook's lazy decoder import
// executable in Jest's VM. Production still uses Metro's asynchronous chunk.
const [babelJest, options] = require('jest-expo/jest-preset').transform['\\.[jt]sx?$'];
module.exports = require(babelJest).createTransformer({
  ...options,
  plugins: [require.resolve('./perfDynamicImport')],
});
