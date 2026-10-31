const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Chromium/libpng warns for some old embedded ICC profiles even though the
 * pixels are valid. Removing only the iCCP chunk keeps the encoded pixels and
 * all other PNG metadata intact while letting the browser use its normal sRGB
 * fallback.
 */
export function sanitizePngDataUrl(value: string) {
  if (!value.startsWith(PNG_PREFIX)) return value;
  try {
    const binary = atob(value.slice(PNG_PREFIX.length));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return value;

    const parts: Uint8Array[] = [bytes.slice(0, PNG_SIGNATURE.length)];
    let cursor = PNG_SIGNATURE.length;
    let removedProfile = false;
    while (cursor + 12 <= bytes.length) {
      const length = readUint32(bytes, cursor);
      const end = cursor + 12 + length;
      if (end > bytes.length) return value;
      const type = String.fromCharCode(...bytes.slice(cursor + 4, cursor + 8));
      if (type === 'iCCP') removedProfile = true;
      else parts.push(bytes.slice(cursor, end));
      cursor = end;
      if (type === 'IEND') break;
    }
    if (!removedProfile || cursor !== bytes.length) return value;

    const sanitized = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      sanitized.set(part, offset);
      offset += part.length;
    }
    return `${PNG_PREFIX}${bytesToBase64(sanitized)}`;
  } catch {
    return value;
  }
}

function readUint32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const blockSize = 0x8000;
  for (let index = 0; index < bytes.length; index += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + blockSize));
  }
  return btoa(binary);
}
