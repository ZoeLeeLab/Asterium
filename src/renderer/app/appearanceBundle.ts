import { CSS_LIMIT } from './appearanceCustomization';
import { normalizeAppearance, type AppearanceSettings } from './appearance';
import { BUNDLE_BYTES, blobDataUrl, imageFromDataUrl, readWallpaper, saveWallpaper, validateWallpaper } from './appearanceImages';

export async function exportAppearance(settings: AppearanceSettings) {
  const images: Record<string, string> = {};
  for (const mode of ['light', 'dark'] as const) {
    const id = settings.customization[mode].background.imageId;
    if (!id || images[id]) continue;
    const blob = await readWallpaper(id);
    if (!blob) throw new Error('自定义背景已丢失，请重新导入图片后再导出。');
    images[id] = await blobDataUrl(blob);
  }
  return JSON.stringify({ format: 'asterium-appearance', version: 1, settings, images }, null, 2);
}
export async function readAppearanceBundle(text: string): Promise<{ settings: AppearanceSettings; images: Map<string, Blob> }> {
  if (text.length > BUNDLE_BYTES) throw new Error('主题包最多 30 MB。');
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error('主题包不是有效 JSON。'); }
  if (!bundle || bundle.format !== 'asterium-appearance' || bundle.version !== 1 || !bundle.settings || !bundle.images || typeof bundle.images !== 'object' || Object.keys(bundle.images).length > 2) throw new Error('主题包格式或版本不支持。');
  if (typeof bundle.settings.customization?.css === 'string' && bundle.settings.customization.css.length > CSS_LIMIT) throw new Error('CSS 最多 64000 个字符。');
  const settings = normalizeAppearance(bundle.settings), images = new Map<string, Blob>();
  // Shared CSS is reviewed and explicitly enabled after import, never silently executed.
  settings.customization.cssEnabled = false;
  for (const mode of ['light', 'dark'] as const) {
    const id = settings.customization[mode].background.imageId;
    if (!id || images.has(id)) continue;
    const blob = imageFromDataUrl(bundle.images[id]);
    await validateWallpaper(blob);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== id) throw new Error('主题包的背景校验失败。');
    images.set(id, blob);
  }
  return { settings, images };
}
export async function installAppearanceBundle(bundle: Awaited<ReturnType<typeof readAppearanceBundle>>) {
  for (const image of bundle.images.values()) await saveWallpaper(image);
  return bundle.settings;
}
