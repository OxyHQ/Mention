const pkg = require('./package.json')

module.exports = function(_config) {
    
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

  /**
   * App variant — lets a development build sit next to the production app on the
   * SAME device by giving it a distinct applicationId/bundleId + name. Build the
   * dev variant with `APP_VARIANT=development`; production is the default.
   * Both packages are present in `google-services.json` so the build passes;
   * FCM push for `earth.mention.app`(.dev) requires those packages to be
   * registered in the Firebase console (project mention-a7a53) and the real
   * `google-services.json` swapped in — until then the entries are placeholders.
   */
  const IS_DEV_VARIANT = process.env.APP_VARIANT === 'development'
  const APP_ID = IS_DEV_VARIANT ? 'earth.mention.app.dev' : 'earth.mention.app'
  const IOS_ID = IS_DEV_VARIANT ? 'earth.mention.app.dev' : 'earth.mention.app'
  const APP_NAME = IS_DEV_VARIANT ? 'Mention (Dev)' : 'Mention'


return {
    expo: {
        name: APP_NAME,
        slug: "mention",
        version: VERSION,
      orientation: 'portrait',
      icon: './assets/images/mention-icon.png',
      scheme: 'mention',
      userInterfaceStyle: 'automatic',
      newArchEnabled: true,
      experiments: {
        typedRoutes: true,
        reactCompiler: true
      },
      ios: {
        supportsTablet: true,
        bundleIdentifier: IOS_ID,
        infoPlist: {
          // Allow Linking.canOpenURL('oxycommons://') so "Sign in with Oxy" can
          // deep-link into Commons on iOS (custom schemes are hidden from
          // canOpenURL unless whitelisted here). Android is unrestricted.
          LSApplicationQueriesSchemes: ['oxycommons'],
        },
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
            // Must match a client package_name in google-services.json.
            package: APP_ID,
            // google-services.json carries both earth.mention.app and its .dev
            // variant so either build passes; real FCM needs those registered
            // in Firebase and the file swapped (see the app-variant note above).
            googleServicesFile: process.env.GOOGLE_SERVICES_JSON || "../../google-services.json",
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
                            IS_DEV && {
                                scheme: 'http',
                                host: '192.168.86.44:3001',
                            },
                            IS_DEV && {
                                scheme: 'http',
                                host: '192.168.86.44:3000',
                            },
                            {
                                scheme: 'https',
                                host: 'oxy.so',
                            },
                            IS_DEV && {
                                scheme: 'http',
                                host: 'localhost:3000',
                            },
                        ],
                        category: ['BROWSABLE', 'DEFAULT'],
                    },
            ],
            softwareKeyboardLayoutMode: "pan",
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./assets/images/favicon.png",
            manifest: "./public/manifest.json",
            meta: {
                viewport: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no",
                themeColor: "#4F46E5",
                mobileWebAppCapable: "yes",
                appleMobileWebAppCapable: "yes",
                appleMobileWebAppStatusBarStyle: "default",
                appleMobileWebAppTitle: "Mention",
                applicationName: "Mention",
                msapplicationTileColor: "#4F46E5",
                msapplicationConfig: "/browserconfig.xml"
            },
            // Web Share Target API (PWA). Installed Mention on Android/Chrome
            // surfaces as a share target; the OS forwards title/text/url as
            // query params to `/compose`, which the compose screen parses via
            // `parseComposeIntent`.
            config: {
                manifest: {
                    share_target: {
                        action: "/compose",
                        method: "GET",
                        enctype: "application/x-www-form-urlencoded",
                        params: {
                            title: "text",
                            text: "text",
                            url: "url"
                        }
                    }
                }
            },
            build: {
          babel: {
            include: ['@expo/vector-icons'],
          },
        },
        // Metro configuration is handled in metro.config.js
        // Removing duplicate configuration here to avoid conflicts
        },
        // Build the plugins array dynamically so we can exclude certain
        // native-only plugins (like expo-notifications) from web builds.
        plugins: (() => {
            const base = [
                [
                    // Async routes split each route into its own lazy chunk under
                    // `_expo/static/js/web/` so heavy screens (compose, videos,
                    // statistics, insights) are fetched on demand instead of
                    // shipping in the entry bundle. Web-only: `production` is the
                    // documented web-only value and is disabled on native (see
                    // expo-router plugin options — the setting lands in
                    // `extra.router.asyncRoutes`, which @expo/metro-config reads).
                    "expo-router",
                    {
                        asyncRoutes: { web: "production" },
                    },
                ],
                [
                    "expo-splash-screen",
                    {
                        // Mention logo (white on transparent) centered on the dark
                        // brand background. The previous white bg is why the white
                        // logo appeared "not to load". The logo PNG is a 1024x1024
                        // square with the visible "M" occupying ~52% wide × ~57%
                        // tall (centered). Android 12+ masks this icon to a CIRCLE:
                        // the 240dp icon window shows only its inner ~2/3 (~160dp
                        // diameter), so the rendered icon must fit that circle.
                        // At imageWidth 176 the visible M renders ~92dp × ~100dp
                        // (bbox diagonal ~136dp) — comfortably inside the ~160dp
                        // safe circle. (The prior 320 pushed the M to ~167×182dp,
                        // which the circle clipped.) Oxy branding is pinned to the
                        // bottom by the `withSplashBranding` plugin below (the
                        // "Instagram, from Meta" pattern).
                        image: "./assets/images/splash-logo.png",
                        imageWidth: 176,
                        resizeMode: "contain",
                        backgroundColor: "#0B0B0F",
                        dark: {
                            image: "./assets/images/splash-logo.png",
                            imageWidth: 176,
                            resizeMode: "contain",
                            backgroundColor: "#0B0B0F"
                        }
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
                "expo-image-picker",
                "expo-video",
                "expo-audio",
                [
                    "expo-secure-store",
                    {
                        configureAndroidBackup: true,
                        faceIDPermission: "Allow $(PRODUCT_NAME) to access your Face ID biometric data."
                    }
                ],
                "expo-sqlite",
                "expo-image",
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
                        deploymentTarget: '16.4',
                        entitlements: {
                          'keychain-access-groups': [
                            '$(AppIdentifierPrefix)group.so.oxy.shared'
                          ]
                        }
                      },
                      android: {
                        compileSdkVersion: 36,
                        targetSdkVersion: 35,
                        buildToolsVersion: '36.0.0',
                        enableProguardInReleaseBuilds: true,
                        enableShrinkResourcesInReleaseBuilds: true,
                        useLegacyPackaging: false
                      },
                    },
                ],
                "expo-web-browser",
                // Android sharedUserId for cross-app authentication
                './plugins/withSharedUserId',
                // Reader side of the shared-identity native module (ships in
                // @oxyhq/services): request the signature permission + <queries>
                // so cold boot can silently read the Commons-hosted shared
                // identity (silent "Sign in with Oxy").
                '@oxyhq/services/plugins/withSharedIdentityReader',
            ];

            // Only include native-only plugins for native builds (android/ios)
            if (PLATFORM !== 'web') {
                base.splice(2, 0, [
                    "expo-notifications",
                    {
                        color: "#ffffff"
                    }
                ]);
                // Add expo-contacts plugin for native platforms only
                base.push([
                    "expo-contacts",
                    {
                        contactsPermission: "Allow $(PRODUCT_NAME) to access your contacts."
                    }
                ]);
                // LiveKit WebRTC plugin for audio spaces
                base.push("@livekit/react-native-expo-plugin");
                // Native share extension — receives text/URL from OS share sheet
                // and routes into `/compose` (see `app/_layout.tsx`).
                base.push([
                    "expo-share-intent",
                    {
                        iosActivationRules: {
                            NSExtensionActivationSupportsText: true,
                            NSExtensionActivationSupportsWebURLWithMaxCount: 1
                        },
                        androidIntentFilters: ["text/*"]
                    }
                ]);
                // Bottom-pinned Oxy branding on the native OS splash ("Instagram,
                // from Meta" pattern). MUST run after `expo-splash-screen` (which
                // generates the Android splash theme + iOS LaunchScreen storyboard
                // this plugin augments). Android 12+ uses the official branding
                // slot; iOS adds a bottom-pinned UIImageView to the storyboard.
                base.push([
                    './plugins/withSplashBranding',
                    {
                        // ANDROID: authored at the OS branding container's 2.5:1
                        // aspect (200:80) — a small centered Oxy symbol inside
                        // transparent padding — because the OS STRETCHES this
                        // drawable to fill that container (it is set as a View
                        // background, not FIT_CENTER). See the plugin header.
                        image: './assets/images/splash-branding-oxy.png',
                        // iOS: the TIGHT square Oxy symbol. iOS uses
                        // scaleAspectFit (no container stretch), so it needs the
                        // symbol without the Android 2.5:1 padding.
                        iosImage: './assets/images/splash-branding-oxy-ios.png',
                        // `imageWidth` is iOS-ONLY (storyboard UIImageView point
                        // width). Android sizing is fixed by the OS container, so
                        // this value does not affect Android. 48pt keeps the iOS
                        // mark a small, discreet bottom symbol.
                        imageWidth: 48
                    }
                ]);
            }

            return base;
        })(),
        extra: {
            eas: {
                projectId: "e1fb5397-4bda-4523-a23e-55bc6da8b244"
            },
            router: {
                origin: false
            }
        },
        owner: "oxyhq"
    }
};
};
