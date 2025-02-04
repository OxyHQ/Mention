module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
        ['module:react-native-dotenv'],
        ['module-resolver', {
          root: ['./src'],
          alias: {
            '@': './src',
          }
        }],
        'module:metro-react-native-babel-preset',
        '@babel/plugin-proposal-export-namespace-from',
        'react-native-reanimated/plugin',
      ],
  };
};
