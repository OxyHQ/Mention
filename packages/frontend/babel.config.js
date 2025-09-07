// packages/frontend/babel.config.js
module.exports = function (api) {
  api.cache(true);
  return {
    // 👇 Treat NativeWind as a PRESET for your version
    presets: [
      [
        'babel-preset-expo',
        {
          jsxImportSource: "nativewind",
          unstable_transformImportMeta: true,
        },
      ],
      'nativewind/babel',
    ],
    plugins: [
      // dotenv (make sure the package is installed in this workspace)
      ['module:react-native-dotenv', {
        moduleName: '@env',
        path: '.env',
        allowUndefined: true,
        safe: false,
      }],
      // resolver
      ['module-resolver', {
        root: ['.'],
        alias: { '@': './' },
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.svg'],
      }],

      '@babel/plugin-transform-dynamic-import',
      '@babel/plugin-proposal-export-namespace-from',

      // must be LAST
      'react-native-reanimated/plugin',
    ],
  };
};
