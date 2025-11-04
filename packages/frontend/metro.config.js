const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

module.exports = (async () => {
  const config = await getDefaultConfig(__dirname);
  const { transformer, resolver } = config;

  // Use the Expo-specific SVG transformer to maintain proper asset handling
  // See: https://github.com/kristerkari/react-native-svg-transformer#expo
  const svgTransformer = require.resolve('react-native-svg-transformer/expo', {
    paths: [__dirname, path.resolve(__dirname, '../../node_modules')],
  });

  config.transformer = { ...transformer, babelTransformerPath: svgTransformer };
  config.resolver = {
    ...resolver,
    assetExts: resolver.assetExts.filter(ext => ext !== 'svg'),
    sourceExts: [...resolver.sourceExts, 'svg'],
    // Monorepo setup: prioritize root node_modules for hoisted dependencies
    // This is required for Expo 54 to properly resolve expo-router and other workspace dependencies
    nodeModulesPaths: [
      path.resolve(__dirname, '../../node_modules'),
      path.resolve(__dirname, 'node_modules'),
    ],
  };

  // Watch the entire monorepo for changes
  config.watchFolders = [
    path.resolve(__dirname, '../..'),
  ];

  try {
    const { withNativeWind } = require('nativewind/metro');
    return withNativeWind(config, { input: './styles/global.css' });
  } catch { return config; }
})();
