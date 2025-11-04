const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

module.exports = (async () => {
  const config = await getDefaultConfig(__dirname);
  const { transformer, resolver } = config;

  const svgTransformer = require.resolve('react-native-svg-transformer', {
    paths: [__dirname, path.resolve(__dirname, '../../node_modules')],
  });

  config.transformer = { ...transformer, babelTransformerPath: svgTransformer };
  config.resolver = {
    ...resolver,
    assetExts: resolver.assetExts.filter(ext => ext !== 'svg'),
    sourceExts: [...resolver.sourceExts, 'svg'],
    nodeModulesPaths: [
      path.resolve(__dirname, '../../node_modules'),
      path.resolve(__dirname, 'node_modules'),
    ],
    resolveRequest: (context, moduleName, platform) => {
      // For expo/AppEntry or expo-router/entry, resolve from root node_modules
      if (moduleName === 'expo/AppEntry' || moduleName === 'expo-router/entry') {
        return {
          filePath: require.resolve(moduleName, {
            paths: [path.resolve(__dirname, '../../node_modules')],
          }),
          type: 'sourceFile',
        };
      }
      // Default resolution
      return context.resolveRequest(context, moduleName, platform);
    },
  };

  config.watchFolders = [
    path.resolve(__dirname, '../../node_modules'),
  ];

  try {
    const { withNativeWind } = require('nativewind/metro');
    return withNativeWind(config, { input: './styles/global.css' });
  } catch { return config; }
})();
