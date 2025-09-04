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
  };

  try {
    const { withNativeWind } = require('nativewind/metro');
    return withNativeWind(config, { input: './styles/global.css' });
  } catch { return config; }
})();
