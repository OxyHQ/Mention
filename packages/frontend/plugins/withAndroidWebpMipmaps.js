/**
 * Expo Config Plugin: withAndroidWebpMipmaps
 *
 * Re-encodes the bitmap resources under `android/app/src/main/res` to real
 * lossless WebP. Expo's generators emit PNG regardless of the extension they
 * write it to, which costs the app twice:
 *
 *  - Launcher icons land as `mipmap-*​/*.webp` holding PNG bytes. AAPT2 stores
 *    `.webp` entries UNCOMPRESSED, so the archive carries a whole PNG with zero
 *    deflate. Re-encoding in place measured -499,551 bytes on this app's APK.
 *  - Splash images land as honest `drawable-*​/*.png`, which AAPT2 does deflate.
 *    Converting them (and renaming to `.webp`) is worth a further -45,068 bytes
 *    measured against the DEFLATED png, not its size on disk. Renaming is safe
 *    because an Android resource is addressed by its filename without the
 *    extension: `@drawable/splashscreen_logo` resolves either way.
 *
 * WHY THIS EXISTS — do not delete it as redundant:
 * `@expo/image-utils` is supposed to use sharp (which honours the requested
 * output format) and only fall back to Jimp (which always emits PNG:
 * `Image.js` -> `resizeAsync` -> `jimp.getBufferAsync('image/png')`) when sharp
 * is unavailable. That fallback is ALWAYS taken, because of a bug in
 * `findSharpBinAsync` (`@expo/image-utils/build/sharp.js`):
 *
 *     109: let _sharpInstance = null;
 *     129:   const sharpInstance = sharpPath ? require(sharpPath) : null;
 *     133:       typeof _sharpInstance?.versions?.vips === 'string') {
 *     135:       _sharpInstance = sharpInstance;
 *
 * Line 133 guards on the module-level cache `_sharpInstance` — null on a cold
 * call — instead of the `sharpInstance` loaded on line 129, and the only
 * assignment to that cache (line 135) sits INSIDE the block that guard
 * protects. The block is therefore unreachable, `isAvailableAsync()` always
 * returns false, and no amount of installing `sharp` or `sharp-cli` changes it
 * (both verified). The bug is still present in the newest published
 * `@expo/image-utils` (0.11.4). This plugin calls sharp directly, so it is
 * unaffected. Once upstream fixes line 133, this plugin becomes a no-op rather
 * than a conflict: it skips files that are already WebP.
 */

const fs = require('fs/promises');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const RES_DIR = path.join('app', 'src', 'main', 'res');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** A RIFF container tagged WEBP: bytes 0-3 `RIFF`, bytes 8-11 `WEBP`. */
function isWebp(buffer) {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}

async function collectBitmapFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectBitmapFiles(entryPath)));
    } else if (entry.name.endsWith('.webp') || entry.name.endsWith('.png')) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Decodes to raw RGBA so the two encodings can be compared pixel for pixel —
 * the same guarantee as PIL's `ImageChops.difference().getbbox() is None`,
 * which is how the saving was validated by hand.
 */
async function toRawRgba(sharp, buffer) {
  return sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

/**
 * True when both buffers render identically.
 *
 * Alpha must match exactly, and so must RGB on every pixel that is even
 * slightly visible. RGB is deliberately NOT compared where alpha is 0: the
 * colour behind a fully transparent pixel cannot be observed, and libwebp
 * rewrites it during lossless encoding because a flat value compresses better.
 * On this app's own icons that accounts for every difference — `ic_launcher_round`
 * at hdpi, for instance, has 1,134 of 5,184 pixels rewritten that way, with 0
 * alpha differences and 0 RGB differences among visible pixels. Comparing the
 * raw bytes instead would reject a conversion that is genuinely lossless.
 */
function rendersIdentically(before, after) {
  if (
    before.info.width !== after.info.width ||
    before.info.height !== after.info.height ||
    before.info.channels !== after.info.channels
  ) {
    return false;
  }
  for (let i = 0; i < before.data.length; i += 4) {
    if (before.data[i + 3] !== after.data[i + 3]) return false;
    if (before.data[i + 3] === 0) continue;
    if (
      before.data[i] !== after.data[i] ||
      before.data[i + 1] !== after.data[i + 1] ||
      before.data[i + 2] !== after.data[i + 2]
    ) {
      return false;
    }
  }
  return true;
}

async function convertResourceImages(projectRoot, resDir) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (error) {
    throw new Error(
      `[withAndroidWebpMipmaps] \`sharp\` is required to emit real WebP resources but could not be loaded (${error.message}). ` +
        'Install it as a devDependency of packages/frontend.',
    );
  }

  const files = await collectBitmapFiles(resDir);
  if (files.length === 0) {
    // A silent no-op is the exact failure mode this plugin exists to prevent:
    // it would leave everyone believing the saving is in place when it is not.
    throw new Error(
      `[withAndroidWebpMipmaps] Found no bitmap resources under ${path.relative(projectRoot, resDir)}. ` +
        'The generated resource layout changed — this plugin needs updating.',
    );
  }

  for (const file of files) {
    const source = await fs.readFile(file);
    if (isWebp(source)) continue;

    if (!source.subarray(0, 4).equals(PNG_MAGIC)) {
      throw new Error(
        `[withAndroidWebpMipmaps] ${path.relative(projectRoot, file)} is neither WebP nor PNG; refusing to guess its format.`,
      );
    }

    const converted = await sharp(source).webp({ lossless: true, effort: 6 }).toBuffer();

    const before = await toRawRgba(sharp, source);
    const after = await toRawRgba(sharp, converted);
    if (!rendersIdentically(before, after)) {
      throw new Error(
        `[withAndroidWebpMipmaps] Lossless conversion of ${path.relative(projectRoot, file)} changed a visible pixel; refusing to write it.`,
      );
    }

    // A resource is addressed by its filename WITHOUT the extension, so a
    // `.png` renamed to `.webp` keeps answering to `@drawable/<name>`. Two
    // files sharing a basename in one directory would become a duplicate
    // resource, so bail rather than create one.
    const target = file.replace(/\.png$/, '.webp');
    if (target !== file && (await exists(target))) {
      throw new Error(
        `[withAndroidWebpMipmaps] Converting ${path.relative(projectRoot, file)} would collide with an existing ${path.basename(target)}.`,
      );
    }

    await fs.writeFile(target, converted);
    if (target !== file) await fs.unlink(file);
  }
}

module.exports = function withAndroidWebpMipmaps(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const { platformProjectRoot, projectRoot } = config.modRequest;
      await convertResourceImages(projectRoot, path.join(platformProjectRoot, RES_DIR));
      return config;
    },
  ]);
};
