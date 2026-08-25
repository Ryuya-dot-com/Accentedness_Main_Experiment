import { describe, expect, it } from "vitest";
import { crc32, createStoredZipStream } from "../src/lib/zip.js";

function parseStoredEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    expect(view.getUint16(offset + 8, true)).toBe(0);
    const expectedCrc32 = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const data = bytes.slice(dataStart, dataStart + size);
    expect(crc32(data)).toBe(expectedCrc32);
    entries.push({ name: decoder.decode(bytes.slice(nameStart, nameStart + nameLength)), data });
    offset = dataStart + size;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  return entries;
}

describe("stored ZIP stream", () => {
  it("streams R2 and inline entries without changing bytes", async () => {
    const wav = new TextEncoder().encode("RIFF-test-wav");
    const manifest = new TextEncoder().encode("{\"ok\":true}\n");
    const bucket = {
      async get(key) {
        expect(key).toBe("recordings/example.wav");
        return {
          size: wav.byteLength,
          customMetadata: { sha256: "source-hash" },
          body: new Blob([wav]).stream(),
        };
      },
    };
    const { readable, completion } = createStoredZipStream({
      bucket,
      generatedAt: new Date("2026-08-25T00:00:00Z"),
      entries: [
        { name: "manifest.json", bytes: manifest, size: manifest.byteLength, crc32: crc32(manifest) },
        {
          name: "wav/01_main_example.wav",
          key: "recordings/example.wav",
          size: wav.byteLength,
          crc32: crc32(wav),
          sha256: "source-hash",
        },
      ],
    });
    const archivePromise = new Response(readable).arrayBuffer();
    const [archive] = await Promise.all([archivePromise, completion]);
    const entries = parseStoredEntries(new Uint8Array(archive));
    expect(entries.map((entry) => entry.name)).toEqual(["manifest.json", "wav/01_main_example.wav"]);
    expect(entries[0].data).toEqual(manifest);
    expect(entries[1].data).toEqual(wav);
  });
});
