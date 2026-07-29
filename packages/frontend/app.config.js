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

  const APP_ENV = process.env.EXPO_PUBLIC_ENV ?? 'development'
  const VALID_APP_ENVS = ['development', 'testflight', 'production']
  if (!VALID_APP_ENVS.includes(APP_ENV)) {
    throw new Error(
      `Invalid EXPO_PUBLIC_ENV "${APP_ENV}". Expected one of: ${VALID_APP_ENVS.join(', ')}`,
    )
  }
  const IS_DEV = APP_ENV === 'development'
  const DEV_HOST = process.env.EXPO_PUBLIC_DEV_HOST?.trim()
  if (DEV_HOST && !/^[a-zA-Z0-9.-]+$/.test(DEV_HOST)) {
    throw new Error(
      'Invalid EXPO_PUBLIC_DEV_HOST. Provide a hostname or IP without a scheme or port.',
    )
  }

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
            versionCode: 2,
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
                                host: 'localhost',
                                port: '3001',
                            },
                            IS_DEV && DEV_HOST && {
                                scheme: 'http',
                                host: DEV_HOST,
                                port: '3001',
                            },
                            IS_DEV && DEV_HOST && {
                                scheme: 'http',
                                host: DEV_HOST,
                                port: '3000',
                            },
                            {
                                scheme: 'https',
                                host: 'oxy.so',
                            },
                            IS_DEV && {
                                scheme: 'http',
                                host: 'localhost',
                                port: '3000',
                            },
                        ].filter(Boolean),
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
                viewport: "width=device-width, initial-scale=1.0",
                themeColor: "#4F46E5",
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
                // Re-encodes the generated bitmap resources into real lossless
                // WebP — Expo emits PNG bytes whatever extension it writes. See
                // the plugin header for the @expo/image-utils bug behind it.
                //
                // Registered FIRST so that it RUNS LAST. `withMod`'s
                // `interceptingMod` awaits its own action and only then calls
                // `nextMod` (the previously registered mod), so the mod chain
                // executes in reverse registration order. It has to run after
                // every image generator: `withSplashBranding` rewrites the
                // splash images, and when this ran before it the tree ended up
                // with both a `.png` and a `.webp` claiming the same
                // `@drawable/splashscreen_logo` resource name.
                './plugins/withAndroidWebpMipmaps',
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
                "expo-image-picker",
                [
                    // Picture-in-Picture for the reels screen (`app/(app)/videos.tsx`),
                    // the only PiP surface. The plugin adds
                    // `android:supportsPictureInPicture="true"` to the main activity and
                    // `UIBackgroundModes: ["audio"]` on iOS (iOS requires the audio
                    // background mode to keep decoding into the PiP window).
                    //
                    // `supportsBackgroundPlayback` stays OFF on purpose: it pulls in an
                    // Android foreground service plus a now-playing notification, which
                    // is background AUDIO, a different feature from PiP.
                    //
                    // `android/` and `ios/` are gitignored (CNG), so this lands at the
                    // next prebuild / EAS build — it does NOT ship over OTA.
                    "expo-video",
                    {
                        supportsPictureInPicture: true,
                    },
                ],
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
                        useLegacyPackaging: false,
                        // x86/x86_64 only serve emulators and Chromebooks, and
                        // Chromebooks translate arm64 anyway. Every configured
                        // ABI is compiled and ships in the AAB, so 4 -> 2 ABIs
                        // halves that work and payload (the x86_64 .so set alone
                        // measures ~47 MB). Build another ABI without editing
                        // this: `./gradlew <task> -PreactNativeArchitectures=x86_64`.
                        buildArchs: ['armeabi-v7a', 'arm64-v8a'],
                        // Appended to android/app/proguard-rules.pro. Kept
                        // deliberately small: react-native, expo-modules-core,
                        // reanimated and @livekit/* already ship their own rules
                        // as consumerProguardFiles inside their AARs, and
                        // over-keeping would cancel the R8 optimization that
                        // withAndroidReleaseBuild turns on.
                        extraProguardRules: [
                          '# Readable production stack traces: R8 optimize rewrites line numbers',
                          '# when inlining, so without these the traces reaching the Play',
                          '# Console point at the wrong code.',
                          '-keepattributes SourceFile,LineNumberTable',
                          '-renamesourcefileattribute SourceFile',
                          '',
                          '# react-native-nitro-modules ships no consumerProguardFiles, and its C++',
                          '# layer resolves HybridObjects by name at runtime.',
                          '-keep class com.margelo.nitro.** { *; }',
                          '-keepclassmembers class * extends com.margelo.nitro.core.HybridObject { *; }',
                        ].join('\n'),
                      },
                    },
                ],
                "expo-web-browser",
                // Release buildType bits expo-build-properties cannot express:
                // the R8 -optimize proguard file, and the real release signing
                // config (credentials come from Gradle properties, never the repo).
                './plugins/withAndroidReleaseBuild',
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
