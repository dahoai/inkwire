import { InkwireError } from "./errors.js";

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const EXTENSION: Record<ImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

/** The image type the bytes really are, from their magic numbers; null for anything else (SVG included). */
export function sniffImage(b: Uint8Array): ImageType | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (b.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70)) {
    // ISO BMFF "ftyp": major brand, then compatible brands, one of them avif/avis.
    const size = Math.min(((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0, b.length, 64);
    for (let i = 8; i + 4 <= size; i += 4) {
      if (i === 12) continue; // minor version
      const brand = String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);
      if (brand === "avif" || brand === "avis") return "image/avif";
    }
  }
  return null;
}

/**
 * Width and height in pixels, read from the file's header; null when the header is not where it
 * should be. The first `ispe` box of an AVIF (ponytail: the primary image in practice, not parsed by item).
 */
export function imageSize(b: Uint8Array, type: ImageType): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  const size = (width: number, height: number) =>
    Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : null;

  if (type === "image/png" && b.length >= 24 && ascii(12, 4) === "IHDR") return size(u32be(16), u32be(20));
  if (type === "image/gif" && b.length >= 10) return size(u16le(6), u16le(8));
  if (type === "image/webp" && b.length >= 30) {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return size(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === "VP8L") {
      const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X") return size(u24le(24) + 1, u24le(27) + 1);
  }
  if (type === "image/jpeg") {
    for (let i = 2; i + 9 <= b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      // SOF0..SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return size(u16be(i + 7), u16be(i + 5));
      i += 2 + u16be(i + 2);
    }
  }
  if (type === "image/avif") {
    const at = Buffer.from(b.subarray(0, Math.min(b.length, 65_536))).indexOf("ispe");
    if (at >= 4 && at + 16 <= b.length) return size(u32be(at + 8), u32be(at + 12));
  }
  return null;
}

const looksLikeSvg = (b: Uint8Array) => {
  const head = Buffer.from(b.subarray(0, 2048)).toString("utf8").toLowerCase();
  return head.includes("<svg") || (head.trimStart().startsWith("<?xml") && head.includes("svg"));
};

const canonicalType = (t: string): string => {
  const base = t.split(";")[0]!.trim().toLowerCase();
  return base === "image/jpg" || base === "image/pjpeg" ? "image/jpeg" : base;
};

/**
 * An image the receiver will store: allowed by declared type AND by its bytes, never SVG (refused
 * by name, by type and by content). The sniffed type wins; a declared type that disagrees is refused.
 */
export function assertImage(bytes: Uint8Array, declaredType: string | undefined, filename: string | undefined): ImageType {
  const declared = declaredType ? canonicalType(declaredType) : undefined;
  if (filename && /\.svgz?$/i.test(filename)) throw new InkwireError("invalid_payload", "SVG images are not accepted");
  if (declared && declared.includes("svg")) throw new InkwireError("invalid_payload", "SVG images are not accepted");
  if (looksLikeSvg(bytes)) throw new InkwireError("invalid_payload", "SVG images are not accepted");
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new InkwireError("invalid_payload", "the file is not a JPEG, PNG, GIF, WebP or AVIF image");
  if (declared && declared !== "application/octet-stream" && declared !== sniffed) {
    if (!(IMAGE_TYPES as readonly string[]).includes(declared)) {
      throw new InkwireError("invalid_payload", `content type ${declared} is not an accepted image type`);
    }
    throw new InkwireError("invalid_payload", `the file says ${declared} but its content is ${sniffed}`);
  }
  return sniffed;
}

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

function boundaryOf(contentType: string): string {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const b = m?.[1] ?? m?.[2];
  if (!b || b.length > 200) throw new InkwireError("invalid_payload", "multipart body has no boundary");
  return b;
}

/** Splits a multipart/form-data body by hand: scan for the boundary, read each part's headers and bytes. */
export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const delim = Buffer.from(`--${boundaryOf(contentType)}`);
  const parts: MultipartPart[] = [];
  let pos = body.indexOf(delim);
  if (pos === -1) throw new InkwireError("invalid_payload", "multipart body is malformed");
  for (;;) {
    pos += delim.length;
    // "--" after the delimiter closes the body; otherwise a line break follows.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;
    else throw new InkwireError("invalid_payload", "multipart body is malformed");

    const headerEnd = body.indexOf("\r\n\r\n", pos);
    if (headerEnd === -1) throw new InkwireError("invalid_payload", "multipart body is malformed");
    const headerText = body.subarray(pos, headerEnd).toString("utf8");
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delim]), headerEnd + 4);
    if (next === -1) throw new InkwireError("invalid_payload", "multipart body is malformed");
    const data = body.subarray(headerEnd + 4, next);

    const headers = new Map<string, string>();
    for (const line of headerText.split(/\r\n/)) {
      const c = line.indexOf(":");
      if (c > 0) headers.set(line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim());
    }
    const disp = headers.get("content-disposition") ?? "";
    const name = /(?:^|[;\s])name="([^"]*)"/i.exec(disp)?.[1] ?? /(?:^|[;\s])name=([^;\s]+)/i.exec(disp)?.[1];
    if (name !== undefined) {
      const filename = /filename="([^"]*)"/i.exec(disp)?.[1] ?? /filename=([^;\s]+)/i.exec(disp)?.[1];
      parts.push({ name, filename, contentType: headers.get("content-type"), data: Buffer.from(data) });
    }
    pos = next + 2; // at the delimiter again
  }
  return parts;
}

/** A filename safe on any disk: no path, no odd characters, an extension that matches the real type. */
export function safeFilename(name: string | undefined, type: ImageType): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const lastDot = base.lastIndexOf(".");
  const rawStem = lastDot > 0 ? base.slice(0, lastDot) : base;
  const stem = rawStem
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80)
    .replace(/[.-]+$/g, "");
  return `${stem || "image"}.${EXTENSION[type]}`;
}
