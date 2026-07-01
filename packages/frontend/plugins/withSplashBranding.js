/**
 * Expo Config Plugin: withSplashBranding
 *
 * Adds bottom-pinned Oxy branding to the NATIVE OS splash screen — the
 * "Instagram, from Meta" pattern (Mention logo centered by expo-splash-screen,
 * Oxy wordmark pinned to the bottom).
 *
 * This plugin MUST run AFTER the `expo-splash-screen` plugin in the config
 * `plugins` array, because it augments the resources that plugin generates:
 *   - Android: the `Theme.App.SplashScreen` style in res/values/styles.xml
 *   - iOS:     the generated `SplashScreen.storyboard`
 *
 * Platform behavior:
 *   - Android 12+ (API 31+): sets `android:windowSplashScreenBrandingImage` on
 *     the splash theme (the OFFICIAL bottom-branding slot). On Android < 12 the
 *     attribute is ignored by the OS (no branding shown) — same as Instagram.
 *   - iOS: adds a bottom-pinned UIImageView to the LaunchScreen storyboard and
 *     registers the branding image in the asset catalog.
 *
 * Options:
 *   - image:      project-relative path to the branding PNG (white/mono on
 *                 transparent). Required.
 *   - imageWidth: display width of the branding image in dp (Android) / pt
 *                 (iOS). Defaults to 150.
 *
 * @see https://developer.android.com/develop/ui/views/launch/splash-screen#set-theme
 */

const {
  withDangerousMod,
  withMod,
  AndroidConfig,
  IOSConfig,
  XML,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Parser, Builder } = require('xml2js');

const ANDROID_DRAWABLE_NAME = 'splashscreen_branding';
const ANDROID_STYLE_NAME = 'Theme.App.SplashScreen';
const ANDROID_BRANDING_ITEM = 'android:windowSplashScreenBrandingImage';

// iOS storyboard node ids. Stable across runs so re-running the plugin replaces
// (rather than duplicates) the branding view/constraints/resource.
const IOS_IMAGE_ID = 'OXY-SplashBranding';
const IOS_CONTAINER_ID = 'EXPO-ContainerView';
const IOS_IMAGE_NAME = 'SplashScreenBranding';
const IOS_IMAGESET = 'Images.xcassets/SplashScreenBranding.imageset';
// Distance from the container bottom to the branding image, in points.
const IOS_BOTTOM_MARGIN = 48;

function resolveOptions(options) {
  const image = options && options.image;
  if (!image) {
    throw new Error(
      "withSplashBranding: `image` option is required (project-relative path to the branding PNG).",
    );
  }
  return { image, imageWidth: (options && options.imageWidth) || 150 };
}

/* ------------------------------- Android ------------------------------- */

// Add `android:windowSplashScreenBrandingImage` to the `Theme.App.SplashScreen`
// style AFTER expo-splash-screen created it. We can't compete in the
// `android.styles` mod chain: mods run last-added-first, and since this plugin
// is registered after expo-splash-screen, our action would run BEFORE the style
// exists. Instead we edit res/values/styles.xml on disk in the `finalized`
// android mod (runs last, after every base mod has written its file), using the
// same expo helpers expo-splash-screen uses so formatting matches exactly.
function addAndroidBrandingStyleItem(config) {
  return withMod(config, {
    platform: 'android',
    mod: 'finalized',
    action: async (config) => {
      const stylesPath =
        await AndroidConfig.Styles.getProjectStylesXMLPathAsync(
          config.modRequest.projectRoot,
        );
      const styles = await AndroidConfig.Resources.readResourcesXMLAsync({
        path: stylesPath,
      });
      const withBranding = AndroidConfig.Styles.assignStylesValue(styles, {
        add: true,
        value: `@drawable/${ANDROID_DRAWABLE_NAME}`,
        name: ANDROID_BRANDING_ITEM,
        parent: {
          name: ANDROID_STYLE_NAME,
          parent: 'Theme.SplashScreen',
        },
      });
      await XML.writeXMLAsync({ path: stylesPath, xml: withBranding });
      return config;
    },
  });
}

function copyAndroidBrandingDrawable(config, options) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const src = path.resolve(config.modRequest.projectRoot, options.image);
      const drawableDir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/res/drawable',
      );
      await fs.promises.mkdir(drawableDir, { recursive: true });
      await fs.promises.copyFile(
        src,
        path.join(drawableDir, `${ANDROID_DRAWABLE_NAME}.png`),
      );
      return config;
    },
  ]);
}

/* --------------------------------- iOS --------------------------------- */

function constraintId(...parts) {
  return crypto.createHash('sha1').update(parts.join('-')).digest('hex');
}

// Mutate the parsed SplashScreen.storyboard XML in place: add the branding
// imageView + bottom/centerX constraints + a resource entry. Idempotent.
function applyBrandingToStoryboardXml(xml, options) {
  const view =
    xml &&
    xml.document &&
    xml.document.scenes &&
    xml.document.scenes[0] &&
    xml.document.scenes[0].scene &&
    xml.document.scenes[0].scene[0] &&
    xml.document.scenes[0].scene[0].objects &&
    xml.document.scenes[0].scene[0].objects[0] &&
    xml.document.scenes[0].scene[0].objects[0].viewController &&
    xml.document.scenes[0].scene[0].objects[0].viewController[0] &&
    xml.document.scenes[0].scene[0].objects[0].viewController[0].view &&
    xml.document.scenes[0].scene[0].objects[0].viewController[0].view[0];
  if (!view) {
    throw new Error(
      'withSplashBranding: unexpected SplashScreen.storyboard shape — ' +
        'the expected view controller view was not found. Ensure ' +
        'expo-splash-screen runs before withSplashBranding.',
    );
  }

  const imageView = {
    $: {
      id: IOS_IMAGE_ID,
      userLabel: IOS_IMAGE_NAME,
      image: IOS_IMAGE_NAME,
      contentMode: 'scaleAspectFit',
      clipsSubviews: 'YES',
      userInteractionEnabled: 'NO',
      translatesAutoresizingMaskIntoConstraints: 'NO',
    },
  };

  // Subviews: drop any prior branding view, then add ours.
  view.subviews = view.subviews || [{}];
  view.subviews[0] = view.subviews[0] || {};
  view.subviews[0].imageView = (view.subviews[0].imageView || []).filter(
    (v) => !(v.$ && v.$.id === IOS_IMAGE_ID),
  );
  view.subviews[0].imageView.push(imageView);

  // Constraints: centerX to container, bottom to container with margin.
  const centerX = {
    $: {
      firstItem: IOS_IMAGE_ID,
      firstAttribute: 'centerX',
      secondItem: IOS_CONTAINER_ID,
      secondAttribute: 'centerX',
      id: constraintId(IOS_IMAGE_ID, 'centerX', IOS_CONTAINER_ID, 'centerX'),
    },
  };
  const bottom = {
    $: {
      firstItem: IOS_CONTAINER_ID,
      firstAttribute: 'bottom',
      secondItem: IOS_IMAGE_ID,
      secondAttribute: 'bottom',
      constant: String(IOS_BOTTOM_MARGIN),
      id: constraintId(IOS_CONTAINER_ID, 'bottom', IOS_IMAGE_ID, 'bottom'),
    },
  };
  view.constraints = view.constraints || [{}];
  view.constraints[0] = view.constraints[0] || {};
  const branded = new Set([centerX.$.id, bottom.$.id]);
  view.constraints[0].constraint = (
    view.constraints[0].constraint || []
  ).filter((c) => !(c.$ && branded.has(c.$.id)));
  view.constraints[0].constraint.push(centerX, bottom);

  // Resource entry so the storyboard can reference the named image.
  xml.document.resources = xml.document.resources || [{}];
  xml.document.resources[0] = xml.document.resources[0] || {};
  xml.document.resources[0].image = (
    xml.document.resources[0].image || []
  ).filter((img) => !(img.$ && img.$.name === IOS_IMAGE_NAME));
  xml.document.resources[0].image.push({
    $: {
      name: IOS_IMAGE_NAME,
      width: String(options.imageWidth),
      height: String(options.imageWidth),
    },
  });

  return xml;
}

// Edit the SplashScreen.storyboard AFTER expo-splash-screen has written it.
// The `finalized` mod runs last in the iOS mod pipeline (after every base mod,
// including the one that writes the storyboard), so the file exists on disk and
// we can read → mutate → write it. We cannot use `withMod` on the
// `splashScreenStoryboard` key because expo-splash-screen inserts that base-mod
// provider LAST in its own chain ("no other mods can be added after this").
function addIosBrandingToStoryboard(config, options) {
  return withMod(config, {
    platform: 'ios',
    mod: 'finalized',
    action: async (config) => {
      const { platformProjectRoot, projectName } = config.modRequest;
      // Matches expo-splash-screen's STORYBOARD_FILE_PATH resolution.
      const storyboardPath = path.join(
        platformProjectRoot,
        projectName,
        'SplashScreen.storyboard',
      );
      const contents = await fs.promises.readFile(storyboardPath, 'utf8');
      const xml = await new Parser().parseStringPromise(contents);
      applyBrandingToStoryboardXml(xml, options);
      const builder = new Builder({
        preserveChildrenOrder: true,
        xmldec: { version: '1.0', encoding: 'UTF-8' },
        renderOpts: { pretty: true, indent: '    ' },
      });
      await fs.promises.writeFile(storyboardPath, builder.buildObject(xml));
      return config;
    },
  });
}

// Register the branding image in the iOS asset catalog as its own imageset.
function addIosBrandingAsset(config, options) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const src = path.resolve(config.modRequest.projectRoot, options.image);
      const sourceRoot = IOSConfig.Paths.getSourceRoot(config.modRequest.projectRoot);
      const imagesetDir = path.join(sourceRoot, IOS_IMAGESET);
      await fs.promises.rm(imagesetDir, { force: true, recursive: true });
      await fs.promises.mkdir(imagesetDir, { recursive: true });

      // Single source PNG reused across scales (the branding mark is small).
      const scales = [
        { file: 'image.png', scale: '1x' },
        { file: 'image@2x.png', scale: '2x' },
        { file: 'image@3x.png', scale: '3x' },
      ];
      await Promise.all(
        scales.map(({ file }) =>
          fs.promises.copyFile(src, path.join(imagesetDir, file)),
        ),
      );
      await fs.promises.writeFile(
        path.join(imagesetDir, 'Contents.json'),
        JSON.stringify(
          {
            images: scales.map(({ file, scale }) => ({
              idiom: 'universal',
              filename: file,
              scale,
            })),
            info: { version: 1, author: 'expo' },
          },
          null,
          2,
        ),
        'utf8',
      );
      return config;
    },
  ]);
}

module.exports = function withSplashBranding(config, options) {
  const resolved = resolveOptions(options);
  config = addAndroidBrandingStyleItem(config);
  config = copyAndroidBrandingDrawable(config, resolved);
  config = addIosBrandingToStoryboard(config, resolved);
  config = addIosBrandingAsset(config, resolved);
  return config;
};
