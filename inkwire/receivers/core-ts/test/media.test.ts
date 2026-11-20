import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InkwireError, assertImage, parseMultipart, safeFilename, sniffImage } from "../src/index.js";
import { PNG, multipart } from "./helpers.js";

const bytes = (...n: number[]) => Uint8Array.from(n);
const pad = (a: Uint8Array, len = 32) => Buffer.concat([Buffer.from(a), Buffer.alloc(len)]);

describe("sniffImage", () => {
  test("recognises the five types by magic bytes", () => {
    assert.equal(sniffImage(pad(bytes(0xff, 0xd8, 0xff, 0xe0))), "image/jpeg");
    assert.equal(sniffImage(PNG), "image/png");
    assert.equal(sniffImage(Buffer.from("GIF89a....")), "image/gif");
    assert.equal(sniffImage(Buffer.from("GIF87a....")), "image/gif");
    assert.equal(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "image/webp");
    const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(4), Buffer.from("mif1avif")]);
    assert.equal(sniffImage(avif), "image/avif");
  });
  test("rejects everything else, including WAV (RIFF but not WEBP), HEIC, svg and short input", () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(4), Buffer.from("mif1")]);
    for (const b of [wav, heic, Buffer.from("<svg/>"), Buffer.alloc(0), Buffer.from([0xff, 0xd8]), Buffer.from("hello")]) {
      assert.equal(sniffImage(b), null);
    }
  });
});

describe("assertImage", () => {
  test("the sniffed type wins; octet-stream or a missing type is fine", () => {
    assert.equal(assertImage(PNG, "image/png", "a.png"), "image/png");
    assert.equal(assertImage(PNG, "application/octet-stream", "a"), "image/png");
    assert.equal(assertImage(PNG, undefined, undefined), "image/png");
    assert.equal(assertImage(PNG, "IMAGE/PNG; charset=x", "a.png"), "image/png");
  });
  test("image/jpg is accepted as jpeg", () => {
    assert.equal(assertImage(pad(bytes(0xff, 0xd8, 0xff)), "image/jpg", "a.jpg"), "image/jpeg");
  });
  test("refuses svg by name (including .svgz), by type, by content", () => {
    for (const [data, type, name] of [
      [PNG, "image/png", "x.SVG"],
      [PNG, "image/png", "x.svgz"],
      [PNG, "image/svg+xml", "x.png"],
      [Buffer.from('  <svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/png", "x.png"],
    ] as const) {
      assert.throws(() => assertImage(data, type, name), (e: unknown) => e instanceof InkwireError && e.code === "invalid_payload" && /SVG/.test(e.message));
    }
  });
});

describe("parseMultipart", () => {
  test("reads names, filenames, content types and binary data intact", () => {
    const bin = Buffer.from([0, 1, 2, 13, 10, 13, 10, 45, 45, 255]); // includes CRLFCRLF and "--"
    const m = multipart([
      { name: "alt", value: "hello" },
      { name: "file", file: { filename: "a b.bin", contentType: "application/x-test", data: bin } },
    ]);
    const parts = parseMultipart(m.body, m.contentType);
    assert.equal(parts.length, 2);
    assert.deepEqual([parts[0]!.name, parts[0]!.data.toString()], ["alt", "hello"]);
    assert.deepEqual([parts[1]!.name, parts[1]!.filename, parts[1]!.contentType], ["file", "a b.bin", "application/x-test"]);
    assert.deepEqual(parts[1]!.data, bin);
  });
  test("quoted boundary parameters work", () => {
    const m = multipart([{ name: "alt", value: "x" }], "q-b");
    assert.equal(parseMultipart(m.body, 'multipart/form-data; boundary="q-b"')[0]!.data.toString(), "x");
  });
  test("malformed bodies throw invalid_payload", () => {
    const m = multipart([{ name: "alt", value: "x" }]);
    for (const [body, type] of [
      [m.body.subarray(0, 40), m.contentType],
      [Buffer.from("garbage"), m.contentType],
      [m.body, "multipart/form-data"],
      [Buffer.from(`--b\r\nContent-Disposition: form-data; name="a"\r\n`), "multipart/form-data; boundary=b"],
    ] as const) {
      assert.throws(() => parseMultipart(Buffer.from(body), type), (e: unknown) => e instanceof InkwireError && e.code === "invalid_payload");
    }
  });
});

describe("safeFilename", () => {
  test("strips paths and odd characters, forces the real extension", () => {
    assert.equal(safeFilename("../../etc/pass wd.png", "image/png"), "pass-wd.png");
    assert.equal(safeFilename("C:\\x\\photo.JPG", "image/jpeg"), "photo.jpg");
    assert.equal(safeFilename("photo.png", "image/webp"), "photo.webp");
    assert.equal(safeFilename(".hidden", "image/gif"), "hidden.gif");
    assert.equal(safeFilename(undefined, "image/avif"), "image.avif");
    assert.equal(safeFilename("日本語.png", "image/png"), "image.png");
    assert.match(safeFilename("x".repeat(500) + ".png", "image/png"), /^x{80}\.png$/);
  });
});
