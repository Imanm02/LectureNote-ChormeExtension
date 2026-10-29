import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

export const STORE_SCREENSHOT_WIDTH = 1280;
export const STORE_SCREENSHOT_HEIGHT = 800;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_DIMENSION = 0x7fffffff;
const MAX_DECODED_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const COLOR_CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);
const VALID_BIT_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

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

function readChunk(image, offset) {
  assert.ok(image.length - offset >= 12, "Screenshot PNG chunk is truncated");

  const length = image.readUInt32BE(offset);
  assert.ok(length <= MAX_PNG_DIMENSION, "Screenshot PNG chunk is too large");

  const typeOffset = offset + 4;
  const dataOffset = typeOffset + 4;
  assert.ok(
    length <= image.length - dataOffset - 4,
    "Screenshot PNG chunk data is truncated",
  );

  const dataEnd = dataOffset + length;
  const end = dataEnd + 4;
  const typeBytes = image.subarray(typeOffset, dataOffset);
  assert.ok(
    typeBytes.every((byte) =>
      (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)),
    "Screenshot PNG has an invalid chunk type",
  );
  assert.equal(
    typeBytes[2] & 0x20,
    0,
    "Screenshot PNG chunk type has an invalid reserved bit",
  );

  const type = typeBytes.toString("ascii");
  const expectedCrc = image.readUInt32BE(dataEnd);
  const actualCrc = crc32(image.subarray(typeOffset, dataEnd));
  assert.equal(actualCrc, expectedCrc, `Screenshot PNG ${type} chunk has an invalid CRC`);

  return {
    data: image.subarray(dataOffset, dataEnd),
    end,
    length,
    type,
    typeBytes,
  };
}

function readHeader(chunk) {
  assert.equal(chunk.length, 13, "Screenshot PNG IHDR chunk must contain 13 bytes");

  const width = chunk.data.readUInt32BE(0);
  const height = chunk.data.readUInt32BE(4);
  const bitDepth = chunk.data[8];
  const colorType = chunk.data[9];
  const compressionMethod = chunk.data[10];
  const filterMethod = chunk.data[11];
  const interlaceMethod = chunk.data[12];

  assert.ok(
    width > 0 && width <= MAX_PNG_DIMENSION,
    "Screenshot PNG width is invalid",
  );
  assert.ok(
    height > 0 && height <= MAX_PNG_DIMENSION,
    "Screenshot PNG height is invalid",
  );
  assert.ok(
    VALID_BIT_DEPTHS.get(colorType)?.has(bitDepth),
    "Screenshot PNG color type and bit depth are invalid",
  );
  assert.equal(compressionMethod, 0, "Screenshot PNG compression method is invalid");
  assert.equal(filterMethod, 0, "Screenshot PNG filter method is invalid");
  assert.equal(
    interlaceMethod,
    0,
    "Interlaced PNG screenshots are not supported",
  );

  return { bitDepth, colorType, height, width };
}

function validatePalette(chunk, header, sawPalette, sawImageData) {
  assert.ok(!sawPalette, "Screenshot PNG contains more than one PLTE chunk");
  assert.ok(!sawImageData, "Screenshot PNG PLTE chunk must precede IDAT");
  assert.ok(
    header.colorType !== 0 && header.colorType !== 4,
    "Screenshot PNG color type cannot contain a PLTE chunk",
  );
  assert.ok(
    chunk.length >= 3 && chunk.length <= 768 && chunk.length % 3 === 0,
    "Screenshot PNG PLTE chunk length is invalid",
  );
  if (header.colorType === 3) {
    assert.ok(
      chunk.length / 3 <= 2 ** header.bitDepth,
      "Screenshot PNG PLTE has too many entries",
    );
  }
}

function validateImageData(chunks, header) {
  const channels = COLOR_CHANNELS.get(header.colorType);
  const rowBits = BigInt(header.width) * BigInt(channels) * BigInt(header.bitDepth);
  const rowBytesBigInt = (rowBits + 7n) / 8n;
  const expectedBytesBigInt = BigInt(header.height) * (rowBytesBigInt + 1n);
  assert.ok(
    expectedBytesBigInt <= BigInt(MAX_DECODED_SCREENSHOT_BYTES),
    "Screenshot PNG decoded image data is too large",
  );

  const rowBytes = Number(rowBytesBigInt);
  const expectedBytes = Number(expectedBytesBigInt);
  const compressed = Buffer.concat(chunks);
  let decoded;
  try {
    decoded = inflateSync(compressed, { maxOutputLength: expectedBytes + 1 });
  } catch {
    assert.fail("Screenshot PNG IDAT data is not valid compressed image data");
  }

  assert.equal(
    decoded.length,
    expectedBytes,
    "Screenshot PNG decoded image data has an invalid scanline length",
  );
  const scanlineBytes = rowBytes + 1;
  for (let row = 0; row < header.height; row += 1) {
    assert.ok(
      decoded[row * scanlineBytes] <= 4,
      `Screenshot PNG scanline ${row + 1} has an invalid filter byte`,
    );
  }
}

export function readPngDimensions(data) {
  const image = Buffer.from(data);
  assert.ok(image.length >= PNG_SIGNATURE.length, "Screenshot PNG is incomplete");
  assert.deepEqual(image.subarray(0, 8), PNG_SIGNATURE, "Screenshot is not a PNG");

  let offset = PNG_SIGNATURE.length;
  let header = null;
  let headerCount = 0;
  let sawImageData = false;
  let imageDataEnded = false;
  const imageDataChunks = [];
  let sawPalette = false;
  let sawEnd = false;

  while (offset < image.length) {
    const chunk = readChunk(image, offset);

    if (header === null) {
      assert.equal(chunk.type, "IHDR", "Screenshot PNG IHDR chunk must be first");
    }

    if (chunk.type === "IHDR") {
      headerCount += 1;
      assert.equal(headerCount, 1, "Screenshot PNG must contain exactly one IHDR chunk");
      assert.equal(offset, PNG_SIGNATURE.length, "Screenshot PNG IHDR chunk must be first");
      header = readHeader(chunk);
    } else if (chunk.type === "PLTE") {
      validatePalette(chunk, header, sawPalette, sawImageData);
      sawPalette = true;
      if (sawImageData) imageDataEnded = true;
    } else if (chunk.type === "IDAT") {
      assert.ok(!imageDataEnded, "Screenshot PNG IDAT chunks must be consecutive");
      assert.ok(
        header.colorType !== 3 || sawPalette,
        "Screenshot PNG indexed color requires a PLTE chunk before IDAT",
      );
      sawImageData = true;
      imageDataChunks.push(chunk.data);
    } else if (chunk.type === "IEND") {
      assert.equal(chunk.length, 0, "Screenshot PNG IEND chunk must be empty");
      assert.ok(sawImageData, "Screenshot PNG must contain at least one IDAT chunk");
      assert.ok(!sawEnd, "Screenshot PNG must contain exactly one IEND chunk");
      sawEnd = true;
      assert.equal(chunk.end, image.length, "Screenshot PNG contains data after IEND");
    } else {
      assert.notEqual(
        chunk.typeBytes[0] & 0x20,
        0,
        `Screenshot PNG contains unsupported critical chunk ${chunk.type}`,
      );
      if (sawImageData) imageDataEnded = true;
    }

    offset = chunk.end;
    if (sawEnd) break;
  }

  assert.equal(headerCount, 1, "Screenshot PNG must contain exactly one IHDR chunk");
  assert.ok(sawImageData, "Screenshot PNG must contain at least one IDAT chunk");
  assert.ok(sawEnd, "Screenshot PNG must contain exactly one terminal IEND chunk");
  validateImageData(imageDataChunks, header);

  return {
    width: header.width,
    height: header.height,
  };
}

export function assertStoreScreenshotDimensions(data, name = "Store screenshot") {
  const dimensions = readPngDimensions(data);
  assert.deepEqual(
    dimensions,
    { width: STORE_SCREENSHOT_WIDTH, height: STORE_SCREENSHOT_HEIGHT },
    `${name} must be ${STORE_SCREENSHOT_WIDTH} by ${STORE_SCREENSHOT_HEIGHT}`,
  );
  return dimensions;
}
