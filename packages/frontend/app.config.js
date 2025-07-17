const pkg = require('./package.json')

module.exports = function(config) {
    
    /**
     * App version number. Should be incremented as part of a release cycle.
     */
  const VERSION = pkg.version

  /**
   * Uses built-in Expo env vars
   *
   * @see https://docs.expo.dev/build-reference/variables/#built-in-environment-variables
   */
  const PLATFORM = process.env.EAS_BUILD_PLATFORM

  const IS_TESTFLIGHT = process.env.EXPO_PUBLIC_ENV === 'testflight'
  const IS_PRODUCTION = process.env.EXPO_PUBLIC_ENV === 'production'
  const IS_DEV = !IS_TESTFLIGHT || !IS_PRODUCTION


return {
    expo: {
        name: "Mention",
        slug: "mention",
        version: VERSION,
        orientation: "portrait",
        icon: "./assets/images/mention-icon.png",
        scheme: "mention",
        userInterfaceStyle: "automatic",
        newArchEnabled: true,
        jsEngine: "jsc",
        ios: {
            supportsTablet: true,
            bundleIdentifier: "earth.mention.android"
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./assets/images/mention-icon_foreground.png",
                backgroundImage: "./assets/images/mention-icon_background.png",
                monochromeImage: "./assets/images/mention-icon_monochrome.png"
            },
            permissions: [
                "android.permission.CAMERA",
                "android.permission.RECORD_AUDIO"
            ],
            package: "earth.mention.android",
            intentFilters: [
                    {
                        action: 'VIEW',
                        autoVerify: true,
                        data: [
                            {
                                scheme: 'https',
                                host: 'mention.earth',
                            },
                            IS_DEV && {
                                scheme: 'http',
                                host: 'localhost:3001',
                            },
                            {
                                scheme: 'https',
                                host: 'oxy.so',
                            },
                            {
                                scheme: 'https',
                                host: 'api.oxy.so',
                            },
                            IS_DEV && {
                                scheme: 'http',
                                host: 'localhost:3000',
                            },
                        ],
                        category: ['BROWSABLE', 'DEFAULT'],
                    },
                ],
        },
        web: {
            bundler: "metro",
            output: "static",
            favicon: "./assets/images/favicon.png"
        },
        plugins: [
            [
                "expo-splash-screen",
                {
                    image: "./assets/images/splash-icon.png",
                    imageWidth: 200,
                    resizeMode: "contain",
                    backgroundColor: "#ffffff"
                }
            ],
            [
                "expo-notifications",
                {
                    color: "#ffffff"
                }
            ],
            [
                "expo-camera",
                {
                    cameraPermission: "Allow $(PRODUCT_NAME) to access your camera",
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone",
                    recordAudioAndroid: true
                }
            ],
            "expo-video",
            "expo-image-picker",
            [
                "expo-secure-store",
                {
                    configureAndroidBackup: true,
                    faceIDPermission: "Allow $(PRODUCT_NAME) to access your Face ID biometric data."
                }
            ],
            [
                'expo-font',
                {
                  fonts: [
                    './assets/fonts/inter/InterVariable.woff2',
                    './assets/fonts/inter/InterVariable-Italic.woff2',
                    // Android only
                    './assets/fonts/inter/Inter-Regular.otf',
                    './assets/fonts/inter/Inter-Italic.otf',
                    './assets/fonts/inter/Inter-SemiBold.otf',
                    './assets/fonts/inter/Inter-SemiBoldItalic.otf',
                    './assets/fonts/inter/Inter-ExtraBold.otf',
                    './assets/fonts/inter/Inter-ExtraBoldItalic.otf',
                    './assets/fonts/Phudu-VariableFont_wght.ttf',
                  ],
                },
              ],
            'react-native-compressor',
            [
                '@bitdrift/react-native',
                {
                    networkInstrumentation: true,
                }
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
            "expo-router",
    "expo-web-browser",
        ],
        extra: {
            eas: {
                projectId: "0ca1d394-efea-4bf7-91b6-ed94a021bcf3"
            },
            router: {
                origin: false
            }
        },
        owner: "oxyhq"
    }
};
};