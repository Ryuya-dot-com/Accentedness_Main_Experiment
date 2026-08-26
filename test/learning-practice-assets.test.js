import { createHash } from "node:crypto";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const FIXTURES = Object.freeze([
  Object.freeze({
    word: "apple",
    hash: "9255e7cb8523858f9728ac2ef42d6016940aa023849bd7f177d08b155096b7f0",
  }),
  Object.freeze({
    word: "orange",
    hash: "f9bd6e66eec6c0a129fc45c7ad554a0ac6e3d856dcf4a27f024122cc7601ef86",
  }),
  Object.freeze({
    word: "book",
    hash: "57d9978e795cf0d7ba2f45fc86a9f4881c97b4a2112a2331674c001be251062c",
  }),
  Object.freeze({
    word: "water",
    hash: "536c8c11ad042f46c8a6a9ce0ce3eac0f6a0c0e2e51f052824f5f17315d15422",
  }),
  Object.freeze({
    word: "car",
    hash: "c5f171836beb4ed2b1d3d13d6b8e81e184903526c64e59e025a275c707704da5",
  }),
  // Retained so an already-created v4 manifest can resume without changing
  // the audio it originally referenced.
  Object.freeze({
    word: "ringo",
    hash: "ad15ed13ee417d96e136982e491d512369548f48dde46c37156cfba313b436a7",
  }),
  Object.freeze({
    word: "mikan",
    hash: "51b5fbb1e61de8253914f5b925564990b0a0bd5b0d38a50a9f9f851f50de43ef",
  }),
]);

async function readPcm16MonoWav(word) {
  const response = await exports.default.fetch(
    new Request(`https://experiment.test/placeholder-audio/${word}.wav`),
  );
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  let offset = 12;
  let format = null;
  let pcm = null;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (dataStart + chunkSize > bytes.length) throw new Error(`${word}: truncated WAV chunk`);
    if (chunkId === "fmt ") {
      format = {
        audioFormat: bytes.readUInt16LE(dataStart),
        channels: bytes.readUInt16LE(dataStart + 2),
        sampleRate: bytes.readUInt32LE(dataStart + 4),
        bitsPerSample: bytes.readUInt16LE(dataStart + 14),
      };
    }
    if (chunkId === "data") pcm = bytes.subarray(dataStart, dataStart + chunkSize);
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  if (!format || !pcm) throw new Error(`${word}: required WAV chunks are missing`);
  return { bytes, format, pcm };
}

describe("versioned practice placeholder TTS", () => {
  it.each(FIXTURES)("keeps $word non-empty, audible, and byte-identical", async ({ word, hash }) => {
    const { bytes, format, pcm } = await readPcm16MonoWav(word);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
    expect(format).toEqual({
      audioFormat: 1,
      channels: 1,
      sampleRate: 44_100,
      bitsPerSample: 16,
    });
    const sampleCount = pcm.length / 2;
    const durationSeconds = sampleCount / format.sampleRate;
    expect(durationSeconds).toBeGreaterThan(0.2);
    expect(durationSeconds).toBeLessThan(2);
    let sumSquares = 0;
    let peak = 0;
    for (let index = 0; index < pcm.length; index += 2) {
      const sample = pcm.readInt16LE(index) / 32_768;
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    expect(Math.sqrt(sumSquares / sampleCount)).toBeGreaterThan(0.01);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(0.98);
  });
});
