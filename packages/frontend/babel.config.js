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
        // resolver must come first for proper module resolution
        ['module-resolver', {
          root: ['./'], // Ensure it resolves relative to package root
          alias: { '@': './' },
          extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.svg'],
        }],
        '@babel/plugin-syntax-dynamic-import',
        '@babel/plugin-transform-export-namespace-from',
        // must be LAST
        'react-native-worklets/plugin',
      ],
    };
  };