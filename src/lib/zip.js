const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
}));

const encoder = new TextEncoder();

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
  };
}

function localHeader(nameBytes, entry, timestamp) {
  const bytes = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, timestamp.time, true);
  view.setUint16(12, timestamp.date, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.size, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  bytes.set(nameBytes, 30);
  return bytes;
}

function centralHeader(nameBytes, entry, timestamp, localOffset) {
  const bytes = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, timestamp.time, true);
  view.setUint16(14, timestamp.date, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  bytes.set(nameBytes, 46);
  return bytes;
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return bytes;
}

function validateEntry(entry) {
  if (!/^[A-Za-z0-9._/-]+$/u.test(entry.name)
      || entry.name.startsWith("/")
      || entry.name.split("/").includes("..")) {
    throw new Error("ZIP entry name is unsafe");
  }
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 0xffffffff) {
    throw new Error("ZIP entry size is invalid");
  }
  if (!Number.isSafeInteger(entry.crc32) || entry.crc32 < 0 || entry.crc32 > 0xffffffff) {
    throw new Error("ZIP entry CRC-32 is invalid");
  }
  if (entry.bytes && entry.bytes.byteLength !== entry.size) {
    throw new Error("Inline ZIP entry size is invalid");
  }
}

export function storedZipSize(entries) {
  let size = 22;
  for (const entry of entries) {
    validateEntry(entry);
    const nameLength = encoder.encode(entry.name).byteLength;
    size += 30 + nameLength + entry.size;
    size += 46 + nameLength;
  }
  if (!Number.isSafeInteger(size) || size > 0xffffffff) {
    throw new Error("ZIP64 would be required for this archive");
  }
  return size;
}

export function createStoredZipStream({ bucket, entries, generatedAt, onComplete, onFailure }) {
  if (!entries.length || entries.length > 0xffff) throw new Error("ZIP entry count is invalid");
  entries.forEach(validateEntry);
  const timestamp = dosDateTime(generatedAt);
  const { readable, writable } = new FixedLengthStream(storedZipSize(entries));
  const writer = writable.getWriter();

  const pump = async () => {
    let offset = 0;
    const centralRecords = [];
    try {
      for (const entry of entries) {
        const nameBytes = encoder.encode(entry.name);
        const localOffset = offset;
        const header = localHeader(nameBytes, entry, timestamp);
        await writer.write(header);
        offset += header.byteLength;

        let streamed = 0;
        if (entry.bytes) {
          streamed = entry.bytes.byteLength;
          await writer.write(entry.bytes);
        } else {
          const object = await bucket.get(entry.key);
          if (!object) throw new Error(`recording_object_missing:${entry.key}`);
          if (Number(object.size) !== entry.size) throw new Error(`recording_object_size_mismatch:${entry.key}`);
          if (entry.sha256 && object.customMetadata?.sha256 !== entry.sha256) {
            throw new Error(`recording_object_checksum_mismatch:${entry.key}`);
          }
          const reader = object.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamed += value.byteLength;
            await writer.write(value);
          }
        }
        if (streamed !== entry.size) throw new Error(`recording_stream_size_mismatch:${entry.key}`);
        offset += streamed;
        centralRecords.push(centralHeader(nameBytes, entry, timestamp, localOffset));
      }

      const centralOffset = offset;
      for (const record of centralRecords) {
        await writer.write(record);
        offset += record.byteLength;
      }
      const centralSize = offset - centralOffset;
      await writer.write(endOfCentralDirectory(entries.length, centralSize, centralOffset));
      try {
        await onComplete?.();
      } catch (error) {
        console.error(JSON.stringify({ message: "recording_export_completion_audit_failed", error: String(error) }));
      }
      await writer.close();
    } catch (error) {
      try {
        await onFailure?.(error);
      } catch (auditError) {
        console.error(JSON.stringify({ message: "recording_export_failure_audit_failed", error: String(auditError) }));
      }
      await writer.abort(error);
      throw error;
    }
  };

  return { readable, completion: pump() };
}
