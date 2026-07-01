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
 *   - image:      project-relative path to the ANDROID branding PNG. Required.
 *                 MUST be authored at the branding container's 2.5:1 aspect
 *                 (see ANDROID note below) — the Oxy symbol centered inside
 *                 transparent padding.
 *   - iosImage:   project-relative path to the iOS branding PNG (the TIGHT
 *                 square Oxy symbol, no padding — iOS uses scaleAspectFit and
 *                 does not stretch). Optional; defaults to `image`.
 *   - imageWidth: iOS-only display width of the branding image in pt. Defaults
 *                 to 150. (Android sizing is fixed by the OS container — see
 *                 below — so this option does NOT affect Android.)
 *
 * ANDROID branding-slot behavior (verified against the framework source):
 *   `windowSplashScreenBrandingImage` is rendered by the OS via
 *   `SplashScreenView` (android/window/SplashScreenView.java), which sets the
 *   drawable as the **background** of a branding view (`setBackground`, not an
 *   ImageView `src`+scaleType). A BitmapDrawable background **stretches to FILL**
 *   the view bounds — it does NOT FIT_CENTER. The WM Shell sizes that view to
 *   the drawable's INTRINSIC dp size, capped at the default branding container
 *   (`splashscreen_default_image_branding_size` = 200dp × 80dp).
 *
 *   Consequences that drive this plugin:
 *     1. Because the background STRETCHES, the source PNG must already be at the
 *        container's 200:80 = 2.5:1 aspect, or the symbol gets distorted (the
 *        old near-square source stretched wide → the "too-wide" bug). The Oxy
 *        symbol is kept small + centered inside transparent padding so the fill
 *        is uniform and the visible mark stays discreet & undistorted.
 *     2. To render SHARP we emit the drawable in `drawable-xxxhdpi` (4× bucket)
 *        at 800×320 px → intrinsic size = 200dp × 80dp = exactly the container.
 *        On xxxhdpi devices it's a 1:1 render; on lower densities the OS scales
 *        the bitmap DOWN (sharp), never up (which is what caused the blur when
 *        the old code shipped a 48px `-nodpi` source stretched to fill).
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
const ImageUtils = require('@expo/image-utils');

const ANDROID_DRAWABLE_NAME = 'splashscreen_branding';
const ANDROID_STYLE_NAME = 'Theme.App.SplashScreen';
const ANDROID_BRANDING_ITEM = 'android:windowSplashScreenBrandingImage';

// AOSP default branding container the OS stretches the drawable to fill
// (`splashscreen_default_image_branding_size`), in dp. See the ANDROID note in
// the file header. We emit the drawable in the xxxhdpi (4×) bucket so its
// intrinsic size equals the container exactly and it renders sharp.
const ANDROID_BRANDING_CONTAINER_WIDTH_DP = 200;
const ANDROID_BRANDING_CONTAINER_HEIGHT_DP = 80;
// xxxhdpi = 4× mdpi. Emitting into `drawable-xxxhdpi` means intrinsic dp =
// px / 4, so these px values resolve to exactly the container dp above.
const ANDROID_XXXHDPI_SCALE = 4;
const ANDROID_BRANDING_DENSITY_DIR = 'drawable-xxxhdpi';

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
      'withSplashBranding: `image` option is required (project-relative path ' +
        'to the ANDROID branding PNG, authored at the OS branding container ' +
        "aspect 2.5:1 — Oxy symbol centered in transparent padding).",
    );
  }
  // iOS uses the tight square symbol (scaleAspectFit, no container stretch);
  // Android uses the 2.5:1-padded canvas (OS stretches to fill). Default the
  // iOS asset to `image` for back-compat, but callers should pass `iosImage`.
  const iosImage = (options && options.iosImage) || image;
  return {
    image,
    iosImage,
    imageWidth: (options && options.imageWidth) || 150,
  };
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

// Emit the Android branding drawable sized to the OS branding container.
//
// The Android 12+ branding slot (`windowSplashScreenBrandingImage`) sets the
// drawable as the BACKGROUND of a branding view sized to the drawable's
// intrinsic dp, capped at the 200dp × 80dp default container. A background
// BitmapDrawable STRETCHES to fill those bounds (it does NOT FIT_CENTER — see
// the file header), so:
//   1. we resize the (already 2.5:1-authored) source to the container aspect at
//      xxxhdpi resolution — 800×320 px = intrinsic 200dp × 80dp = the container
//      exactly, so the stretch is a no-op and nothing is distorted; and
//   2. we place it in `drawable-xxxhdpi` so on a 4× device it's a 1:1 render
//      (sharp) and on lower densities the OS scales the bitmap DOWN, never up.
// The visible Oxy mark stays small + centered because the source carries the
// transparent padding; the fill is uniform, so the symbol keeps its aspect.
//
// Resizing goes through `@expo/image-utils` (`generateImageAsync`) — the same
// resizer expo-splash-screen itself uses (sharp when installed, jimp fallback),
// so it's always resolvable in an Expo project without a new dependency.
function copyAndroidBrandingDrawable(config, options) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const src = path.resolve(config.modRequest.projectRoot, options.image);
      // Full container size at xxxhdpi: intrinsic dp = px / 4 = 200 × 80 dp.
      const targetWidth =
        ANDROID_BRANDING_CONTAINER_WIDTH_DP * ANDROID_XXXHDPI_SCALE;
      const targetHeight =
        ANDROID_BRANDING_CONTAINER_HEIGHT_DP * ANDROID_XXXHDPI_SCALE;
      // `resizeMode: 'cover'` would crop; the source is already authored at the
      // container's 2.5:1 aspect, so 'contain' fits it exactly with no letterbox
      // and no aspect change. (A guard below fails loudly if the source aspect
      // drifts, since a mismatched source WOULD distort under the OS fill.)
      const { width: srcWidth, height: srcHeight } =
        await ImageUtils.getPngInfo(src);
      const srcAspect = srcWidth / srcHeight;
      const containerAspect =
        ANDROID_BRANDING_CONTAINER_WIDTH_DP /
        ANDROID_BRANDING_CONTAINER_HEIGHT_DP;
      if (Math.abs(srcAspect - containerAspect) > 0.02) {
        throw new Error(
          `withSplashBranding: Android branding source aspect ${srcAspect.toFixed(
            3,
          )} does not match the OS branding container aspect ${containerAspect.toFixed(
            3,
          )} (200:80). The OS stretches this drawable to fill the container, so ` +
            'the source PNG must be authored at 2.5:1 (Oxy symbol centered in ' +
            'transparent padding) or it will render distorted.',
        );
      }
      const { source } = await ImageUtils.generateImageAsync(
        { projectRoot: config.modRequest.projectRoot, cacheType: 'splash-branding' },
        {
          src,
          resizeMode: 'contain',
          width: targetWidth,
          height: targetHeight,
        },
      );
      const drawableDir = path.join(
        config.modRequest.platformProjectRoot,
        `app/src/main/res/${ANDROID_BRANDING_DENSITY_DIR}`,
      );
      await fs.promises.mkdir(drawableDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(drawableDir, `${ANDROID_DRAWABLE_NAME}.png`),
        source,
      );
      // Remove any drawable emitted by a previous version of this plugin at a
      // different density bucket so an incremental (non-clean) prebuild can't
      // leave two `splashscreen_branding` drawables and pick the stale one.
      await Promise.all(
        ['drawable-nodpi', 'drawable', 'drawable-mdpi'].map((dir) =>
          fs.promises.rm(
            path.join(
              config.modRequest.platformProjectRoot,
              `app/src/main/res/${dir}/${ANDROID_DRAWABLE_NAME}.png`,
            ),
            { force: true },
          ),
        ),
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

  // Resource entry so the storyboard can reference the named image. The
  // declared width/height must match the actual (symbol) aspect so Interface
  // Builder's design-time intrinsic size is correct; `options.iosImageHeight`
  // is derived from the cropped symbol aspect by addIosBrandingAsset.
  xml.document.resources = xml.document.resources || [{}];
  xml.document.resources[0] = xml.document.resources[0] || {};
  xml.document.resources[0].image = (
    xml.document.resources[0].image || []
  ).filter((img) => !(img.$ && img.$.name === IOS_IMAGE_NAME));
  xml.document.resources[0].image.push({
    $: {
      name: IOS_IMAGE_NAME,
      width: String(options.imageWidth),
      height: String(options.iosImageHeight || options.imageWidth),
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
//
// iOS renders the branding via a storyboard UIImageView with `scaleAspectFit`
// and NO size constraints, so the view sizes to the image's intrinsic point
// size (px ÷ scale). Unlike Android, iOS does NOT stretch-to-fill, so it uses
// the TIGHT square Oxy symbol source (`options.iosImage`), NOT the 2.5:1-padded
// Android source. The square PNG is copied unchanged across @1x/@2x/@3x (it is
// authored at ≥3× the display size, so it stays sharp), and its intrinsic size
// is capped by the storyboard resource width/height below.
function addIosBrandingAsset(config, options) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const src = path.resolve(
        config.modRequest.projectRoot,
        options.iosImage,
      );
      const sourceRoot = IOSConfig.Paths.getSourceRoot(config.modRequest.projectRoot);
      const imagesetDir = path.join(sourceRoot, IOS_IMAGESET);
      await fs.promises.rm(imagesetDir, { force: true, recursive: true });
      await fs.promises.mkdir(imagesetDir, { recursive: true });

      // Derive the symbol's true aspect so the storyboard resource declares a
      // non-square size if the symbol isn't square (keeps design-time layout
      // honest; runtime uses scaleAspectFit so it never stretches regardless).
      const { width: symW, height: symH } = await ImageUtils.getPngInfo(src);
      options.iosImageHeight = Math.round(
        (Math.round(options.imageWidth) * symH) / symW,
      );

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
              scale: `${scale}x`,
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
