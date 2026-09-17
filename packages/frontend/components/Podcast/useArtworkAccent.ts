import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/**
 * The background a podcast card paints behind white text: the artwork's own
 * dominant color, pushed dark enough that the title stays legible on it.
 *
 * Web samples the artwork on a canvas (needs a CORS-enabled image; a tainted
 * canvas throws and we fall back). Native has no pixel access through
 * expo-image, so it — and any failed sample — gets a stable hue hashed from the
 * artwork URL, which at least keeps one show one color everywhere.
 */

const cache = new Map<string, string>();

function hashHue(seed: string): number {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
}

function fallbackAccent(seed: string): string {
    return `hsl(${hashHue(seed)}, 42%, 30%)`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
}

/** Legible-under-white: lightness clamped to 22–34%, a floor on saturation for colorful art. */
function toAccent(r: number, g: number, b: number): string {
    const [h, s, l] = rgbToHsl(r, g, b);
    const sat = s < 0.08 ? s : Math.max(s, 0.38);
    const light = Math.min(Math.max(l, 0.22), 0.34);
    return `hsl(${Math.round(h)}, ${Math.round(Math.min(sat, 0.7) * 100)}%, ${Math.round(light * 100)}%)`;
}

function sampleOnWeb(url: string): Promise<string | null> {
    return new Promise((resolve) => {
        const img = new (globalThis as unknown as { Image: typeof HTMLImageElement }).Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const size = 24;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                if (!ctx) return resolve(null);
                ctx.drawImage(img, 0, 0, size, size);
                const { data } = ctx.getImageData(0, 0, size, size);
                // Saturation-weighted mean: a gray border or white title text on
                // the cover should not wash out the color the art is known by.
                let rs = 0, gs = 0, bs = 0, ws = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const [, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
                    const w = 0.05 + s * (1 - Math.abs(l - 0.5) * 1.6);
                    rs += data[i] * w; gs += data[i + 1] * w; bs += data[i + 2] * w; ws += w;
                }
                resolve(ws > 0 ? toAccent(rs / ws, gs / ws, bs / ws) : null);
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

export function useArtworkAccent(artworkUrl: string | undefined, override?: string, seed = ''): string {
    const key = artworkUrl ?? seed;
    // Only the async web sample lives in state; everything else is derived, so a
    // recycled row never shows the previous show's color for a frame.
    const [sampled, setSampled] = useState<{ key: string; color: string } | null>(null);

    const needsSample = !override && !cache.has(key) && Platform.OS === 'web' && Boolean(artworkUrl);
    useEffect(() => {
        if (!needsSample || !artworkUrl) return;
        let cancelled = false;
        sampleOnWeb(artworkUrl).then((color) => {
            if (!color) return;
            cache.set(key, color);
            if (!cancelled) setSampled({ key, color });
        });
        return () => {
            cancelled = true;
        };
    }, [needsSample, artworkUrl, key]);

    if (override) return override;
    return cache.get(key) ?? (sampled?.key === key ? sampled.color : fallbackAccent(key));
}
