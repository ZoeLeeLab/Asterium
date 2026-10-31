const DATABASE = 'asterium-appearance-images';
export const IMAGE_BYTES = 10 * 1024 * 1024;
export const BUNDLE_BYTES = 30 * 1024 * 1024;

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开背景存储。'));
  });
}
async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('images', mode), request = action(tx.objectStore('images'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(new Error('背景存储失败，请检查磁盘空间。'));
    });
  } finally { db.close(); }
}
export const readWallpaper = (id: string): Promise<Blob | undefined> => transact('readonly', store => store.get(id));
export async function pruneWallpapers(keepIds: string[]) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite'), store = tx.objectStore('images'), request = store.openCursor();
      request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (!keepIds.includes(String(cursor.key))) cursor.delete(); cursor.continue(); };
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('背景清理失败。'));
    });
  } finally { db.close(); }
}
export async function validateWallpaper(blob: Blob): Promise<void> {
  if (!blob.size || blob.size > IMAGE_BYTES) throw new Error('背景图片需小于 10 MB。');
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const png = b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71;
  const jpg = b[0] === 255 && b[1] === 216 && b[2] === 255;
  const webp = String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP';
  if (!png && !jpg && !webp) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch { throw new Error('图片无法解码，请重新选择。'); }
  const valid = bitmap.width <= 16000 && bitmap.height <= 16000 && bitmap.width * bitmap.height <= 32_000_000;
  bitmap.close();
  if (!valid) throw new Error('图片尺寸过大，请使用不超过 3200 万像素的图片。');
}
export async function saveWallpaper(blob: Blob): Promise<string> {
  await validateWallpaper(blob);
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const id = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  await transact('readwrite', store => store.put(blob, id));
  return id;
}
export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败。'));
    reader.readAsDataURL(blob);
  });
}
export function imageFromDataUrl(value: unknown): Blob {
  if (typeof value !== 'string' || value.length > IMAGE_BYTES * 1.4 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('主题包的背景图片格式无效。');
  const [header, data] = value.split(',');
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)); } catch { throw new Error('主题包的背景图片无法读取。'); }
  return new Blob([bytes], { type: header.slice(5, header.indexOf(';')) });
}
