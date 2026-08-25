import { describe, expect, it } from "vitest";
import { validatePcmWav } from "../src/routes-participant.js";

function canonicalSilenceWav(sampleRate = 8_000, durationSeconds = 10) {
  const sampleCount = sampleRate * durationSeconds;
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  return bytes;
}

describe("canonical participant WAV validation", () => {
  it("accepts the exact browser encoder layout", () => {
    expect(validatePcmWav(canonicalSilenceWav(), "picture_naming")).toMatchObject({
      sampleRate: 8_000,
      sampleCount: 80_000,
      durationSeconds: 10,
    });
  });

  it("rejects data appended after the canonical PCM data chunk", () => {
    const canonical = canonicalSilenceWav();
    const tailed = new Uint8Array(canonical.byteLength + 8);
    tailed.set(canonical);
    const view = new DataView(tailed.buffer);
    view.setUint32(4, tailed.byteLength - 8, true);
    for (const [index, character] of [..."JUNK"].entries()) {
      view.setUint8(canonical.byteLength + index, character.charCodeAt(0));
    }
    view.setUint32(canonical.byteLength + 4, 0, true);
    expect(() => validatePcmWav(tailed, "picture_naming")).toThrow(
      "WAV must end immediately after its canonical PCM data chunk",
    );
  });
});
