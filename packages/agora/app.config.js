const pkg = require('./package.json');

module.exports = function (_config) {
  const VERSION = pkg.version;
  const PLATFORM = process.env.EAS_BUILD_PLATFORM;

  return {
    expo: {
      name: 'Agora by Mention',
      slug: 'agora',
      version: VERSION,
      orientation: 'portrait',
      icon: './assets/images/icon.png',
      scheme: 'agora',
      userInterfaceStyle: 'automatic',
      newArchEnabled: true,
      experiments: {
        typedRoutes: true,
        reactCompiler: true,
      },
      ios: {
        supportsTablet: true,
        bundleIdentifier: 'earth.mention.agora',
      },
      android: {
        adaptiveIcon: {
          foregroundImage: './assets/images/adaptive-icon.png',
          backgroundColor: '#FFC107',
        },
        permissions: [
          'android.permission.RECORD_AUDIO',
        ],
        package: 'earth.mention.agora',
        intentFilters: [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [
              { scheme: 'https', host: 'agora.mention.earth' },
            ],
            category: ['BROWSABLE', 'DEFAULT'],
          },
        ],
        softwareKeyboardLayoutMode: 'pan',
        edgeToEdgeEnabled: true,
      },
      web: {
        bundler: 'metro',
        output: 'static',
        favicon: './assets/images/favicon.png',
        meta: {
          viewport: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no',
          themeColor: '#FFC107',
          appleMobileWebAppCapable: 'yes',
          appleMobileWebAppStatusBarStyle: 'default',
          appleMobileWebAppTitle: 'Agora',
          applicationName: 'Agora by Mention',
          msapplicationTileColor: '#FFC107',
        },
        build: {
          babel: {
            include: ['@expo/vector-icons'],
          },
        },
      },
      plugins: (() => {
        const base = [
          'expo-router',
          [
            'expo-splash-screen',
            {
              image: './assets/images/splash-icon.png',
              imageWidth: 200,
              resizeMode: 'contain',
              backgroundColor: '#ffffff',
            },
          ],
          'expo-image-picker',
          'expo-audio',
          [
            'expo-secure-store',
            {
              configureAndroidBackup: true,
              faceIDPermission: 'Allow $(PRODUCT_NAME) to access your Face ID biometric data.',
            },
          ],
          [
            'expo-font',
            {
              fonts: ['./assets/fonts/inter/InterVariable.ttf'],
            },
          ],
          [
            'expo-build-properties',
            {
              ios: {
                deploymentTarget: '15.1',
              },
              android: {
                compileSdkVersion: 35,
                targetSdkVersion: 35,
                buildToolsVersion: '35.0.0',
              },
            },
          ],
          'expo-web-browser',
        ];

        if (PLATFORM !== 'web') {
          base.push('@livekit/react-native-expo-plugin');
        }

        return base;
      })(),
      extra: {
        eas: {
          projectId: 'e89d44d7-74e3-460e-b5c3-5bce6a19fb1d',
        },
        router: {
          origin: false,
        },
      },
      owner: 'oxyhq',
    },
  };
};
