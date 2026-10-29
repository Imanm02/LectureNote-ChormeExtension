import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  assertStoreScreenshotDimensions,
  readPngDimensions,
  STORE_SCREENSHOT_HEIGHT,
  STORE_SCREENSHOT_WIDTH,
} from "../scripts/store-screenshot-utils.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function pngHeaderData(width, height, overrides = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = overrides.bitDepth ?? 8;
  header[9] = overrides.colorType ?? 6;
  header[10] = overrides.compressionMethod ?? 0;
  header[11] = overrides.filterMethod ?? 0;
  header[12] = overrides.interlaceMethod ?? 0;
  return header;
}

function decodedImageData(width, height, options = {}) {
  const colorType = options.colorType ?? 6;
  const bitDepth = options.bitDepth ?? 8;
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
  ]).get(colorType);
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  return Buffer.alloc(height * (rowBytes + 1));
}

function pngImage(
  width = STORE_SCREENSHOT_WIDTH,
  height = STORE_SCREENSHOT_HEIGHT,
  options = {},
) {
  const headerOptions = options.header ?? {};
  const decoded = options.decoded ?? decodedImageData(width, height, headerOptions);
  const compressed = options.compressed ?? deflateSync(decoded);
  const split = options.splitIdat ? Math.max(1, Math.floor(compressed.length / 2)) : null;
  const imageDataChunks = split === null
    ? [pngChunk("IDAT", compressed)]
    : [
        pngChunk("IDAT", compressed.subarray(0, split)),
        pngChunk("IDAT", compressed.subarray(split)),
      ];
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", pngHeaderData(width, height, headerOptions)),
    ...imageDataChunks,
    pngChunk("IEND"),
  ]);
}

test("reads and accepts a complete Chrome Web Store screenshot PNG", () => {
  const image = pngImage(STORE_SCREENSHOT_WIDTH, STORE_SCREENSHOT_HEIGHT, {
    splitIdat: true,
  });

  assert.deepEqual(readPngDimensions(image), {
    width: 1280,
    height: 800,
  });
  assert.deepEqual(assertStoreScreenshotDimensions(image, "Example"), {
    width: 1280,
    height: 800,
  });
});

test("rejects invalid or incorrectly sized screenshots", () => {
  assert.throws(
    () => readPngDimensions(Buffer.alloc(24)),
    /not a PNG/u,
  );
  assert.throws(
    () => assertStoreScreenshotDimensions(pngImage(640, 400), "Small image"),
    /must be 1280 by 800/u,
  );
});

test("rejects corrupt CRC values and truncated chunks", () => {
  const corruptCrc = pngImage(2, 2);
  corruptCrc[29] ^= 0x01;
  assert.throws(
    () => readPngDimensions(corruptCrc),
    /IHDR chunk has an invalid CRC/u,
  );

  const truncated = pngImage(2, 2).subarray(0, -1);
  assert.throws(
    () => readPngDimensions(truncated),
    /chunk is truncated/u,
  );

  const oversizedChunk = pngImage(2, 2);
  oversizedChunk.writeUInt32BE(1000, 33);
  assert.throws(
    () => readPngDimensions(oversizedChunk),
    /chunk data is truncated/u,
  );
});

test("rejects missing, duplicate, misplaced, or invalid required chunks", () => {
  const header = pngChunk("IHDR", pngHeaderData(1280, 800));
  const imageData = pngChunk("IDAT", Buffer.from([0]));
  const end = pngChunk("IEND");

  const cases = [
    {
      image: Buffer.concat([PNG_SIGNATURE, header, end]),
      message: /at least one IDAT/u,
    },
    {
      image: Buffer.concat([PNG_SIGNATURE, header, imageData]),
      message: /terminal IEND/u,
    },
    {
      image: Buffer.concat([PNG_SIGNATURE, header, header, imageData, end]),
      message: /exactly one IHDR/u,
    },
    {
      image: Buffer.concat([PNG_SIGNATURE, imageData, end]),
      message: /IHDR chunk must be first/u,
    },
    {
      image: Buffer.concat([
        PNG_SIGNATURE,
        pngChunk("IHDR", pngHeaderData(1280, 800).subarray(0, 12)),
        imageData,
        end,
      ]),
      message: /IHDR chunk must contain 13 bytes/u,
    },
    {
      image: Buffer.concat([
        PNG_SIGNATURE,
        pngChunk("IHDR", pngHeaderData(1280, 800, { colorType: 1 })),
        imageData,
        end,
      ]),
      message: /color type and bit depth are invalid/u,
    },
    {
      image: Buffer.concat([
        PNG_SIGNATURE,
        pngChunk("IHDR", pngHeaderData(1280, 800, { interlaceMethod: 1 })),
        imageData,
        end,
      ]),
      message: /Interlaced PNG screenshots are not supported/u,
    },
    {
      image: Buffer.concat([
        PNG_SIGNATURE,
        header,
        imageData,
        pngChunk("IEND", Buffer.from([0])),
      ]),
      message: /IEND chunk must be empty/u,
    },
    {
      image: Buffer.concat([
        PNG_SIGNATURE,
        header,
        pngChunk("ABCD"),
        imageData,
        end,
      ]),
      message: /unsupported critical chunk ABCD/u,
    },
    {
      image: Buffer.concat([
        PNG_SIGNATURE,
        header,
        pngChunk("ID1T"),
        imageData,
        end,
      ]),
      message: /invalid chunk type/u,
    },
  ];

  for (const { image, message } of cases) {
    assert.throws(() => readPngDimensions(image), message);
  }
});

test("rejects broken chunk ordering and bytes after IEND", () => {
  const valid = pngImage(2, 2);
  assert.throws(
    () => readPngDimensions(Buffer.concat([valid, Buffer.from([0])])),
    /data after IEND/u,
  );

  const header = pngChunk("IHDR", pngHeaderData(1280, 800));
  const imageData = pngChunk("IDAT", Buffer.from([0]));
  const text = pngChunk("tEXt", Buffer.from("source\0test", "latin1"));
  assert.throws(
    () => readPngDimensions(Buffer.concat([
      PNG_SIGNATURE,
      header,
      imageData,
      text,
      imageData,
      pngChunk("IEND"),
    ])),
    /IDAT chunks must be consecutive/u,
  );
});

test("rejects corrupt compressed data and invalid decoded scanlines", () => {
  assert.throws(
    () => readPngDimensions(pngImage(2, 2, {
      compressed: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    })),
    /IDAT data is not valid compressed image data/u,
  );

  const truncatedScanlines = decodedImageData(2, 2).subarray(0, -1);
  assert.throws(
    () => readPngDimensions(pngImage(2, 2, { decoded: truncatedScanlines })),
    /invalid scanline length/u,
  );

  const invalidFilter = decodedImageData(2, 2);
  invalidFilter[9] = 5;
  assert.throws(
    () => readPngDimensions(pngImage(2, 2, { decoded: invalidFilter })),
    /scanline 2 has an invalid filter byte/u,
  );
});
