// `.bloom` modules (Bloom's own language) under the unit config: compiled to
// TypeScript by the Bloom language compiler, then Expo's normal transform, as
// Metro does for the app (`metro.config.js`).
const { createTransformer } = require('@oxy.so/bloom-language-compiler/jest');

module.exports = createTransformer({
  upstream: require('jest-expo/jest-preset').transform['\\.[jt]sx?$'],
});
