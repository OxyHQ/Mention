module.exports = function(api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    plugins: [
      ['module:react-native-dotenv'],
      ['module-resolver', {
        root: ['.'],
        alias: {
          '@': './'
        },
        extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
      }],
      '@babel/plugin-proposal-export-namespace-from',
      'react-native-reanimated/plugin', // Ensure this is the last plugin
    ],
  };
};
