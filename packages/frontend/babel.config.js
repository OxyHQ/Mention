// packages/frontend/babel.config.js
module.exports = function (api) {
    api.cache(true);
    return {
      presets: [
        [
          'babel-preset-expo',
          {
            unstable_transformImportMeta: true,
          },
        ],
        'react-native-css/babel',
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
      ],
    };
  };