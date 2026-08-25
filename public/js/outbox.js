import { sha256Blob } from "./api.js";

const DB_NAME = "accentedness_main_experiment";
const DB_VERSION = 3;
const OUTBOX_STORE = "trial_outbox";
const START_STORE = "trial_starts";
const VISIT_INDEX = "visitId";

function ascii(view, offset, length) {
  let output = "";
  for (let index = 0; index < length; index += 1) output += String.fromCharCode(view.getUint8(offset + index));
  return output;
}

function preflightError(message) {
  const error = new Error(message);
  error.code = "client_recording_preflight_failed";
  return error;
}

async function validateRecordingBeforeCanonicalization(blob, payload) {
  if (!(blob instanceof Blob)) throw preflightError("録音Blobがありません。");
  const bytes = await blob.arrayBuffer();
  if (bytes.byteLength < 44) throw preflightError("録音WAVが短すぎます。");
  const view = new DataView(bytes);
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE"
      || ascii(view, 12, 4) !== "fmt " || view.getUint32(16, true) !== 16
      || ascii(view, 36, 4) !== "data" || view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw preflightError("録音WAVの構造が不正です。");
  }
  const sampleRate = view.getUint32(24, true);
  const dataBytes = view.getUint32(40, true);
  const sampleCount = dataBytes / 2;
  if (view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
      || view.getUint16(34, true) !== 16 || dataBytes + 44 !== bytes.byteLength
      || sampleRate !== payload.sample_rate_hz || sampleCount !== payload.sample_count
      || Math.abs(sampleCount / sampleRate - payload.duration_seconds) > 0.01) {
    throw preflightError("録音WAVと試行メタデータが一致しません。");
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const outbox = db.objectStoreNames.contains(OUTBOX_STORE)
        ? request.transaction.objectStore(OUTBOX_STORE)
        : db.createObjectStore(OUTBOX_STORE, { keyPath: "attemptId" });
      if (!outbox.indexNames.contains(VISIT_INDEX)) outbox.createIndex(VISIT_INDEX, "visitId", { unique: false });
      // Records from schema v1 had no visitId and cannot be safely associated with a participant.
      outbox.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        if (!cursor.value?.visitId) cursor.delete();
        cursor.continue();
      };
      if (!db.objectStoreNames.contains(START_STORE)) db.createObjectStore(START_STORE, { keyPath: "trialId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, operation) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      try {
        result = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export async function queueTrial(record) {
  if (!record.visitId) throw new Error("visitId is required for durable trial storage");
  if (record.expectsRecording) {
    await validateRecordingBeforeCanonicalization(record.recordingBlob, record.payload);
  }
  const enriched = {
    ...record,
    responseAck: false,
    recordingAck: !record.expectsRecording,
    recordingSha256: record.recordingBlob ? await sha256Blob(record.recordingBlob) : null,
    queuedAtMs: Date.now(),
  };
  await withStore(OUTBOX_STORE, "readwrite", (store) => store.put(enriched));
  return enriched;
}

export async function listQueuedTrials(visitId) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(OUTBOX_STORE, "readonly")
        .objectStore(OUTBOX_STORE)
        .index(VISIT_INDEX)
        .getAll(visitId);
      request.onsuccess = () => resolve(
        request.result
          .sort((a, b) => a.queuedAtMs - b.queuedAtMs),
      );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function updateQueued(record) {
  await withStore(OUTBOX_STORE, "readwrite", (store) => store.put(record));
}

async function deleteQueued(attemptId) {
  await withStore(OUTBOX_STORE, "readwrite", (store) => store.delete(attemptId));
}

async function queuedTrial(attemptId) {
  return withStore(OUTBOX_STORE, "readonly", (store) => store.get(attemptId));
}

export function isQueuedTrialFullyAcknowledged(record) {
  return Boolean(record?.responseAck && record?.recordingAck);
}

export function fullyAcknowledgedAttemptIds(records) {
  return records
    .filter(isQueuedTrialFullyAcknowledged)
    .map((record) => record.attemptId);
}

export async function purgeFullyAcknowledgedTrials() {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(OUTBOX_STORE, "readwrite");
      const store = transaction.objectStore(OUTBOX_STORE);
      const request = store.getAll();
      let removedCount = 0;
      request.onsuccess = () => {
        const attemptIds = fullyAcknowledgedAttemptIds(request.result);
        removedCount = attemptIds.length;
        for (const attemptId of attemptIds) store.delete(attemptId);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(removedCount);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(
        transaction.error ?? new Error("IndexedDB transaction aborted"),
      );
    });
  } finally {
    db.close();
  }
}

export async function hasQueuedRecording(visitId, attemptId) {
  const record = await queuedTrial(attemptId);
  return Boolean(
    record
      && record.visitId === visitId
      && record.attemptId === attemptId
      && record.expectsRecording
      && !record.recordingAck
      && record.recordingBlob instanceof Blob
      && record.recordingSha256,
  );
}

export async function acknowledgeTrialResponse(api, attemptId) {
  const record = await queuedTrial(attemptId);
  if (!record) throw new Error(`保存待ち試行が見つかりません: ${attemptId}`);
  if (!record.responseAck) {
    await api.saveResponse(record.trialId, record.attemptId, record.responseKey, record.payload);
    record.responseAck = true;
    await updateQueued(record);
  }
  if (isQueuedTrialFullyAcknowledged(record)) await deleteQueued(record.attemptId);
  return record;
}

export async function uploadQueuedRecording(api, attemptId) {
  const record = await queuedTrial(attemptId);
  if (!record || !record.expectsRecording || record.recordingAck) return record;
  if (!record.responseAck) await acknowledgeTrialResponse(api, attemptId);
  const current = await queuedTrial(attemptId);
  if (!current) return null;
  if (!(current.recordingBlob instanceof Blob) || !current.recordingSha256) {
    throw preflightError("録音データがIndexedDBにありません。担当者に知らせてください。");
  }
  await api.uploadRecording(current.attemptId, current.recordingBlob, current.recordingSha256);
  current.recordingAck = true;
  await updateQueued(current);
  const finished = await queuedTrial(attemptId);
  if (isQueuedTrialFullyAcknowledged(finished)) await deleteQueued(attemptId);
  return finished;
}

export async function getOrCreateTrialStart(visitId, trialId) {
  const existing = await withStore(START_STORE, "readonly", (store) => store.get(trialId));
  if (existing) {
    if (existing.visitId !== visitId) throw new Error("Stored trial start belongs to a different visit");
    return existing;
  }
  const created = {
    visitId,
    trialId,
    startKey: crypto.randomUUID(),
    clientStartedPerfMs: performance.now(),
    createdAtMs: Date.now(),
  };
  await withStore(START_STORE, "readwrite", (store) => store.put(created));
  return created;
}

export async function clearTrialStart(trialId) {
  await withStore(START_STORE, "readwrite", (store) => store.delete(trialId));
}

export async function markTrialStimulusShown(trialId) {
  const existing = await withStore(START_STORE, "readonly", (store) => store.get(trialId));
  if (!existing) throw new Error("Durable trial start is missing before stimulus onset");
  existing.stimulusShown = true;
  existing.stimulusMarkedAtMs = Date.now();
  await withStore(START_STORE, "readwrite", (store) => store.put(existing));
}

export async function flushOutbox(api, visitId, onState = () => {}) {
  // Scan the whole outbox, rather than only this visit. A crash after the two
  // remote acknowledgements but before delete must not leave a raw WAV behind
  // merely because the participant's next link belongs to another visit.
  await purgeFullyAcknowledgedTrials();
  const records = await listQueuedTrials(visitId);
  for (const record of records) {
    onState({ state: "saving", record });
    if (!record.responseAck) {
      await acknowledgeTrialResponse(api, record.attemptId);
    }
    if (record.expectsRecording && !record.recordingAck) {
      await uploadQueuedRecording(api, record.attemptId);
    }
    onState({ state: "saved", record });
  }
  return records.length;
}
