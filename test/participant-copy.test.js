import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/crypto.js";
import { crc32 } from "../src/lib/stored-zip.js";
import { seedVisit, silenceWav } from "./helpers/participant-copy-fixture.js";
import { participantCopyFilename } from "../src/routes-participant-copy.js";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";

async function request(path, { method = "GET", token = null, body = null } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== null) headers.set("Content-Type", "application/json");
  const response = await exports.default.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
  }));
  return response;
}

async function jsonRequest(path, options = {}) {
  const response = await request(path, options);
  return { response, json: await response.json() };
}

async function startVisit(participantId, visitType) {
  const result = await jsonRequest("/api/participant-access/start", {
    method: "POST",
    body: {
      participant_id: participantId,
      participant_id_confirmed: true,
      client_instance_id: crypto.randomUUID(),
      expected_visit_type: visitType,
    },
  });
  expect(result.response.status).toBe(200);
  return result.json;
}

async function createParticipant(participantId) {
  const start = await startVisit(participantId, "pre");
  const rows = await env.DB.prepare(`
    SELECT p.participant_uuid, v.visit_uuid, v.visit_type
    FROM participants p JOIN visits v ON v.participant_uuid = p.participant_uuid
    WHERE p.numeric_id = ?
  `).bind(participantId).all();
  const participant = { participant_id: participantId, participant_uuid: rows.results[0].participant_uuid };
  for (const visit of rows.results) participant[`${visit.visit_type}_visit_id`] = visit.visit_uuid;
  return { participant, start };
}

function validPictureNamingPayload() {
  return {
    task: "picture_naming",
    client_response_saved_perf_ms: 10_500,
    visual_mode: "image",
    visual_onset_perf_ms: 350,
    visual_onset_context_s: 1,
    clock_anchor: {
      context_time_s: 1,
      performance_time_ms: 350,
      performance_time_origin_ms: 1_000,
    },
    target_onset_perf_ms: 350,
    onset_late_ms: 0,
    response_deadline_perf_ms: 10_350,
    response_deadline_context_s: 11,
    visual_hidden_perf_ms: 10_351,
    response_window_ms: 10_000,
    sample_rate_hz: 48_000,
    sample_count: 480_000,
    duration_seconds: 10,
    capture_start_context_s: 1,
    capture_stop_context_s: 11,
    capture_stop_command_perf_ms: 10_350,
    capture_stopped_perf_ms: 10_360,
    scheduled_stop_context_s: 11,
    expected_sample_count: 480_000,
    sample_count_difference: 0,
    missing_input_frames: 0,
    visibility_interrupted: false,
    measured_pre_roll_ms: 0,
    microphone_settings: {
      sample_rate: 48_000,
      channel_count: 1,
      echo_cancellation: false,
      noise_suppression: false,
      auto_gain_control: false,
    },
    quality: {
      analysis_start_seconds: 0,
      analyzed_sample_count: 480_000,
      rms_amplitude: 0,
      peak_amplitude: 0,
      clipping_ratio: 0,
    },
  };
}

function parseStoredEntries(archiveBytes) {
  const bytes = new Uint8Array(archiveBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  const localEntries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const storedCrc32 = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    const data = bytes.slice(dataStart, dataStart + size);
    expect(crc32(data)).toBe(storedCrc32);
    entries.set(name, data);
    localEntries.set(name, { crc32: storedCrc32, size, offset });
    offset = dataStart + size;
  }

  const endOffset = bytes.byteLength - 22;
  expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  expect(entryCount).toBe(localEntries.size);
  expect(centralOffset).toBe(offset);
  expect(centralOffset + centralSize).toBe(endOffset);

  let centralCursor = centralOffset;
  let centralCount = 0;
  while (centralCursor < endOffset) {
    expect(view.getUint32(centralCursor, true)).toBe(0x02014b50);
    expect(view.getUint16(centralCursor + 10, true)).toBe(0);
    const storedCrc32 = view.getUint32(centralCursor + 16, true);
    const storedSize = view.getUint32(centralCursor + 20, true);
    expect(view.getUint32(centralCursor + 24, true)).toBe(storedSize);
    const nameLength = view.getUint16(centralCursor + 28, true);
    const extraLength = view.getUint16(centralCursor + 30, true);
    const commentLength = view.getUint16(centralCursor + 32, true);
    const localOffset = view.getUint32(centralCursor + 42, true);
    const name = decoder.decode(bytes.slice(
      centralCursor + 46,
      centralCursor + 46 + nameLength,
    ));
    expect(localEntries.get(name)).toEqual({
      crc32: storedCrc32,
      size: storedSize,
      offset: localOffset,
    });
    centralCursor += 46 + nameLength + extraLength + commentLength;
    centralCount += 1;
  }
  expect(centralCount).toBe(entryCount);
  return entries;
}

async function completeVisit(token) {
  const response = await request("/api/visit/complete", { method: "POST", token, body: {} });
  expect(response.status).toBe(200);
}

async function expectParticipantCopy(token, visitTypes, responseCount, recordingCount) {
  // Query parameters cannot expand the authenticated session's copy scope.
  const response = await request("/api/visit/results.zip?visit_type=delayed&participant_id=902", { token });
  expect(response.status).toBe(200);
  const archive = await response.arrayBuffer();
  expect(archive.byteLength).toBe(Number(response.headers.get("Content-Length")));
  const entries = parseStoredEntries(archive);
  const document = JSON.parse(new TextDecoder().decode(entries.get("responses.json")));
  expect(document.participant).toEqual({ participant_id: 901 });
  expect(response.headers.get("Content-Disposition"))
    .toBe(`attachment; filename="${participantCopyFilename(901, visitTypes.at(-1), document.generated_at_ms)}"`);
  expect(document.visits.map((visit) => visit.visit_type)).toEqual(visitTypes);
  expect(document.responses).toHaveLength(responseCount);
  expect(document.responses.every((row) => visitTypes.includes(row.visit_type) && !row.research)).toBe(true);
  expect([...entries.keys()].filter((name) => name.endsWith(".wav"))).toHaveLength(recordingCount);
  expect(entries.size).toBe(recordingCount + 2);
  expect(new TextDecoder().decode(entries.get("README.txt"))).toContain("録音を聞き返したりせず");
  const text = new TextDecoder().decode(archive);
  expect(text).not.toMatch(/casket|english|chinese|japanese|test_f|design\.json|item_assignments|learning_trials/iu);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu);
  return document;
}

describe("on-demand result ZIP", () => {
  it.each(["pre", "immediate", "delayed"])("names the %s ZIP with the numeric ID and generation date in Japan", (visitType) => {
    expect(participantCopyFilename(901, visitType, Date.parse("2026-09-05T14:59:59.999Z")))
      .toBe(`accentedness_p901_${visitType}_20260905.zip`);
    expect(participantCopyFilename(1, visitType, Date.parse("2026-09-05T15:00:00.000Z")))
      .toBe(`accentedness_p1_${visitType}_20260906.zip`);
  });

  it("copies only the completed session's visit prefix without labels or UUIDs", async () => {
    const created = await createParticipant(901);

    const pre = created.start;
    const preForbidden = await request("/api/visit/results.zip", { token: pre.session_token });
    expect(preForbidden.status).toBe(409);
    await seedVisit(env, created.participant.pre_visit_id, pre.session.session_id, "pre");
    await completeVisit(pre.session_token);
    const preCopy = await expectParticipantCopy(pre.session_token, ["pre"], 26, 24);

    const immediate = await startVisit(901, "immediate");
    await seedVisit(env,
      created.participant.immediate_visit_id,
      immediate.session.session_id,
      "immediate",
    );
    const immediateForbidden = await request("/api/visit/results.zip", { token: immediate.session_token });
    expect(immediateForbidden.status).toBe(409);
    await completeVisit(immediate.session_token);
    const immediateCopy = await expectParticipantCopy(immediate.session_token, ["pre", "immediate"], 231, 78);
    await env.DB.prepare(`
      UPDATE visits SET target_at_ms = 1, available_at_ms = 1 WHERE visit_uuid = ?
    `).bind(created.participant.delayed_visit_id).run();

    const delayed = await startVisit(901, "delayed");
    const routeUploadedTrial = delayed.manifest.find((trial) => trial.expects_recording);
    await seedVisit(env,
      created.participant.delayed_visit_id,
      delayed.session.session_id,
      "delayed",
      { skipTrialUuid: routeUploadedTrial.trial_id },
    );
    const started = await jsonRequest(`/api/trials/${routeUploadedTrial.trial_id}/start`, {
      method: "POST",
      token: delayed.session_token,
      body: {
        start_key: crypto.randomUUID(),
        client_started_perf_ms: 1,
        resume_after_stimulus: false,
      },
    });
    expect(started.response.status).toBe(201);
    await env.DB.prepare(`
      UPDATE trial_attempts SET server_started_at_ms = server_started_at_ms - 10000
      WHERE attempt_uuid = ?
    `).bind(started.json.attempt_id).run();
    const saved = await jsonRequest(`/api/trials/${routeUploadedTrial.trial_id}/response`, {
      method: "PUT",
      token: delayed.session_token,
      body: {
        attempt_id: started.json.attempt_id,
        response_key: crypto.randomUUID(),
        payload: validPictureNamingPayload(),
      },
    });
    expect(saved.response.status).toBe(200);
    const routeUploadedWav = silenceWav();
    const routeUploadedSha256 = await sha256Hex(routeUploadedWav);
    const uploaded = await exports.default.fetch(new Request(
      `${ORIGIN}/api/recordings/${started.json.attempt_id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${delayed.session_token}`,
          "Content-Type": "audio/wav",
          "Content-Length": String(routeUploadedWav.byteLength),
          "X-Content-SHA256": routeUploadedSha256,
        },
        body: routeUploadedWav,
      },
    ));
    expect(uploaded.status).toBe(200);
    const beforeCompletion = await jsonRequest("/api/visit/results.zip", {
      token: delayed.session_token,
    });
    expect(beforeCompletion.response.status).toBe(409);
    expect(beforeCompletion.json.error.code).toBe("participant_copy_before_completion");

    await completeVisit(delayed.session_token);
    const downloaded = await request("/api/visit/results.zip", { token: delayed.session_token });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("Content-Type")).toBe("application/zip");
    const archive = await downloaded.arrayBuffer();
    expect(archive.byteLength).toBe(Number(downloaded.headers.get("Content-Length")));
    const entries = parseStoredEntries(archive);
    const responses = JSON.parse(new TextDecoder().decode(entries.get("responses.json")));
    expect(downloaded.headers.get("Content-Disposition"))
      .toBe(`attachment; filename="${participantCopyFilename(901, "delayed", responses.generated_at_ms)}"`);
    expect(responses.participant).toEqual({ participant_id: 901 });
    expect(new TextDecoder().decode(entries.get("README.txt")))
      .toContain("参加者IDと録音が含まれます");
    expect(new TextDecoder().decode(entries.get("README.txt")))
      .toContain("見えない場所へ移動するか削除");
    expect(responses.visits.map((visit) => visit.visit_type)).toEqual([
      "pre",
      "immediate",
      "delayed",
    ]);
    expect(new Set(responses.responses.map((row) => row.visit_type))).toEqual(
      new Set(["pre", "immediate", "delayed"]),
    );
    expect(responses.copy_purpose).toBe("participant_local_copy");
    expect(responses.responses.every((row) => row.research === undefined)).toBe(true);
    expect(entries.has("design.json")).toBe(false);
    expect(entries.has("item_assignments.csv")).toBe(false);
    expect(entries.has("learning_trials.csv")).toBe(false);
    const participantWavEntries = [...entries.keys()].filter((name) => name.endsWith(".wav"));
    expect(participantWavEntries).toHaveLength(132);
    expect(responses.visits.map((visit) => ({
      visit_type: visit.visit_type,
      copied_recording_count: visit.copied_recording_count,
    }))).toEqual([
      { visit_type: "pre", copied_recording_count: 24 },
      { visit_type: "immediate", copied_recording_count: 54 },
      { visit_type: "delayed", copied_recording_count: 54 },
    ]);
    const participantSpokenPractice = responses.responses.filter(
      (row) => row.practice && row.segment !== "learning",
    );
    expect(participantSpokenPractice)
      .toHaveLength(12);
    expect(participantSpokenPractice
      .every((row) => row.recording === null && row.expects_recording === false))
      .toBe(true);
    expect([...entries.keys()]).toContain("recordings/pre/picture_naming/recording_003.wav");
    expect([...entries.keys()]).toContain("recordings/immediate/l2_to_l1/recording_004.wav");
    expect([...entries.keys()]).toContain("recordings/delayed/l2_to_l1/recording_004.wav");
    expect(entries.get("recordings/delayed/picture_naming/recording_003.wav"))
      .toEqual(routeUploadedWav);
    const routeUploadedRecording = await env.DB.prepare(`
      SELECT crc32, sha256, byte_count FROM recordings WHERE attempt_uuid = ?
    `).bind(started.json.attempt_id).first();
    expect(routeUploadedRecording).toMatchObject({
      crc32: crc32(routeUploadedWav),
      sha256: routeUploadedSha256,
      byte_count: routeUploadedWav.byteLength,
    });
    const exposedText = new TextDecoder().decode(archive);
    expect(exposedText).not.toMatch(/casket|english|chinese|japanese|test_f/iu);
    expect(exposedText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu);

    // Later visits must not expand an earlier completed session's archive.
    const preCopyAgain = await expectParticipantCopy(pre.session_token, ["pre"], 26, 24);
    const immediateCopyAgain = await expectParticipantCopy(immediate.session_token, ["pre", "immediate"], 231, 78);
    expect(preCopyAgain.responses).toEqual(preCopy.responses);
    expect(preCopyAgain.visits).toEqual(preCopy.visits);
    expect(immediateCopyAgain.responses).toEqual(immediateCopy.responses);
    expect(immediateCopyAgain.visits).toEqual(immediateCopy.visits);

    const adminDownload = await request(
      `/api/admin/participants/${created.participant.participant_id}/results.zip`,
      { token: ADMIN_TOKEN },
    );
    expect(adminDownload.status).toBe(200);
    expect(adminDownload.headers.get("Content-Disposition"))
      .toContain("accentedness_p901_results.zip");
    const adminEntries = parseStoredEntries(await adminDownload.arrayBuffer());
    const adminResponses = JSON.parse(
      new TextDecoder().decode(adminEntries.get("responses.json")),
    );
    const adminWavEntries = [...adminEntries.keys()].filter((name) => name.endsWith(".wav"));
    expect(adminWavEntries).toHaveLength(132);
    expect(new Set(adminWavEntries)).toEqual(new Set(participantWavEntries));
    expect(adminResponses.responses.filter(
      (row) => row.practice && row.segment !== "learning",
    )
      .every((row) => row.recording === null && row.expects_recording === false))
      .toBe(true);
    expect(adminResponses.copy_purpose).toBe("research_admin_copy");
    expect(adminResponses.responses[0].research).toMatchObject({
      trial_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      attempt_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      attempt_no: 1,
      repeated_after_interruption: false,
      extra_exposure: false,
      item: {
        id: expect.any(Number),
        word: expect.any(String),
        gloss: expect.any(String),
        asset_version: expect.any(String),
      },
    });
    expect(adminResponses.responses.find((row) => row.recording)?.research.recording_storage)
      .toMatchObject({
        r2_key: expect.any(String),
        crc32: expect.any(Number),
        latency_reference: {
          event: "picture_onset",
          seconds_in_recording: expect.any(Number),
          acoustic_offset_correction_required: false,
        },
        received_at_ms: expect.any(Number),
      });
    expect(adminResponses.responses.find(
      (row) => row.segment === "l2_to_l1" && row.recording,
    ).research.recording_storage.latency_reference).toMatchObject({
      event: "test_audio_buffer_end",
      seconds_in_recording: expect.any(Number),
      acoustic_offset_correction_required: true,
    });

    const design = JSON.parse(new TextDecoder().decode(adminEntries.get("design.json")));
    const storedParticipantDesign = await env.DB.prepare(`
      SELECT numeric_id, training_accent, within_accent_q, counterbalance_cycle,
        counterbalance_cell, list_cell, order_cell, talker_cell,
        assignment_version, seed_algorithm_version, asset_version
      FROM participants WHERE numeric_id = 901
    `).first();
    const storedVisitDesign = await env.DB.prepare(`
      SELECT visit_type, manifest_hash FROM visits
      WHERE participant_uuid = (SELECT participant_uuid FROM participants WHERE numeric_id = 901)
      ORDER BY CASE visit_type WHEN 'pre' THEN 1 WHEN 'immediate' THEN 2 ELSE 3 END
    `).all();
    expect(design).toEqual({
      design_export_version: 1,
      participant: {
        participant_id: Number(storedParticipantDesign.numeric_id),
        training_accent: storedParticipantDesign.training_accent,
        counterbalance: {
          within_accent_q: Number(storedParticipantDesign.within_accent_q),
          cycle: Number(storedParticipantDesign.counterbalance_cycle),
          cell: Number(storedParticipantDesign.counterbalance_cell),
          list_cell: Number(storedParticipantDesign.list_cell),
          order_cell: Number(storedParticipantDesign.order_cell),
          talker_cell: Number(storedParticipantDesign.talker_cell),
        },
        assignment_version: storedParticipantDesign.assignment_version,
        seed_algorithm_version: storedParticipantDesign.seed_algorithm_version,
        asset_version: storedParticipantDesign.asset_version,
      },
      visits: storedVisitDesign.results,
    });
    expect(JSON.stringify(design)).not.toMatch(/participant_name|root_seed/iu);

    const itemAssignmentsCsvBytes = adminEntries.get("item_assignments.csv");
    expect([...itemAssignmentsCsvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const itemAssignmentsCsv = new TextDecoder().decode(itemAssignmentsCsvBytes);
    const itemAssignmentLines = itemAssignmentsCsv.trimEnd().split("\r\n");
    const itemAssignmentHeaders = itemAssignmentLines[0].split(",");
    expect(itemAssignmentHeaders).toEqual([
      "participant_id",
      "training_accent",
      "counterbalance_cell",
      "list_cell",
      "order_cell",
      "talker_cell",
      "item_id",
      "item_word",
      "item_gloss",
      "list_id",
      "list_rank",
      "variability",
      "no_training_talker_id",
      "test_accent",
      "test_talker_id",
      "assignment_version",
      "asset_version",
    ]);
    const itemAssignmentRecords = itemAssignmentLines.slice(1).map((line) => {
      const values = line.split(",");
      return Object.fromEntries(
        itemAssignmentHeaders.map((header, index) => [header, values[index]]),
      );
    });
    const storedItemAssignments = await env.DB.prepare(`
      SELECT ia.item_id, ia.list_id, ia.list_rank, ia.variability,
             ia.no_talker_id, ia.test_accent, ia.test_talker_id, ia.asset_version,
             tm.item_word, tm.item_gloss,
             tm.list_id AS manifest_list_id,
             tm.list_rank AS manifest_list_rank,
             tm.variability AS manifest_variability
      FROM participants p
      JOIN item_assignments ia ON ia.participant_uuid = p.participant_uuid
      JOIN visits v
        ON v.participant_uuid = p.participant_uuid
       AND v.visit_type = 'immediate'
      JOIN trial_manifest tm
        ON tm.visit_uuid = v.visit_uuid
       AND tm.segment = 'learning'
       AND tm.practice = 0
       AND tm.exposure = 1
       AND tm.item_id = ia.item_id
      WHERE p.numeric_id = 901
      ORDER BY ia.item_id
    `).all();
    expect(itemAssignmentRecords).toHaveLength(24);
    expect(itemAssignmentRecords.map((record) => Number(record.item_id)))
      .toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
    expect(storedItemAssignments.results).toHaveLength(24);
    itemAssignmentRecords.forEach((record, index) => {
      const stored = storedItemAssignments.results[index];
      expect(Number(stored.manifest_list_id)).toBe(Number(stored.list_id));
      expect(Number(stored.manifest_list_rank)).toBe(Number(stored.list_rank));
      expect(stored.manifest_variability).toBe(stored.variability);
      expect(record).toMatchObject({
        participant_id: "901",
        training_accent: storedParticipantDesign.training_accent,
        counterbalance_cell: String(storedParticipantDesign.counterbalance_cell),
        list_cell: String(storedParticipantDesign.list_cell),
        order_cell: String(storedParticipantDesign.order_cell),
        talker_cell: String(storedParticipantDesign.talker_cell),
        item_id: String(stored.item_id),
        item_word: stored.item_word,
        item_gloss: stored.item_gloss,
        list_id: String(stored.list_id),
        list_rank: String(stored.list_rank),
        variability: stored.variability,
        no_training_talker_id: stored.variability === "no" ? stored.no_talker_id : "",
        test_accent: stored.test_accent,
        test_talker_id: stored.test_talker_id,
        assignment_version: storedParticipantDesign.assignment_version,
        asset_version: stored.asset_version,
      });
    });
    for (const listId of ["1", "2"]) {
      expect(itemAssignmentRecords.filter((record) => record.list_id === listId))
        .toHaveLength(12);
    }
    const noRows = itemAssignmentRecords.filter((record) => record.variability === "no");
    const highRows = itemAssignmentRecords.filter((record) => record.variability === "high");
    expect(noRows).toHaveLength(12);
    expect(highRows).toHaveLength(12);
    expect(noRows.every((record) => record.no_training_talker_id !== "")).toBe(true);
    expect(new Set(noRows.map((record) => record.no_training_talker_id)).size).toBe(1);
    expect(highRows.every((record) => record.no_training_talker_id === "")).toBe(true);
    const expectedTestTalkers = {
      english: "E6_Audio",
      chinese: "C11_Natural",
      japanese: "J5_Natural",
    };
    for (const accent of ["english", "chinese", "japanese"]) {
      expect(itemAssignmentRecords.filter((record) => record.test_accent === accent))
        .toHaveLength(8);
      expect(itemAssignmentRecords
        .filter((record) => record.test_accent === accent)
        .every((record) => record.test_talker_id === expectedTestTalkers[accent]))
        .toBe(true);
      for (const variability of ["no", "high"]) {
        expect(itemAssignmentRecords.filter((record) => (
          record.variability === variability && record.test_accent === accent
        ))).toHaveLength(4);
      }
    }
    expect(itemAssignmentsCsv)
      .not.toMatch(/participant_name|root_seed|_uuid|r2_key|Test Participant/iu);
    expect(itemAssignmentsCsv)
      .not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu);
    expect(itemAssignmentsCsv).not.toContain("recordings/");

    const learningCsvBytes = adminEntries.get("learning_trials.csv");
    expect([...learningCsvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const learningCsv = new TextDecoder().decode(learningCsvBytes);
    const learningLines = learningCsv.trimEnd().split("\r\n");
    const learningHeaders = learningLines[0].split(",");
    expect(learningLines).toHaveLength(
      adminResponses.responses.filter((row) => row.segment === "learning").length + 1,
    );
    expect(learningHeaders).toContain("planned_variability");
    expect(learningHeaders).toContain("planned_talker_id");
    expect(learningHeaders).toContain("planned_visual_duration_ms");
    expect(learningHeaders).toContain("runtime_canonical_response_state");
    expect(learningHeaders).toContain("runtime_total_attempt_count");
    expect(learningHeaders).toContain("runtime_noncanonical_attempt_count");
    expect(learningHeaders).toContain("runtime_server_trial_start_accepted_at_ms");
    expect(learningHeaders).toContain("runtime_client_response_saved_perf_ms");
    expect(learningHeaders).toContain("runtime_visual_onset_perf_ms");
    expect(learningHeaders).toContain("runtime_audio_scheduled_context_s");
    const learningRecords = learningLines.slice(1).map((line) => {
      const values = line.split(",");
      return Object.fromEntries(
        learningHeaders.map((header, index) => [header, values[index]]),
      );
    });
    const firstLearning = learningRecords.find((record) => record.planned_practice === "false");
    expect(firstLearning).toMatchObject({
      csv_version: "1",
      participant_id: "901",
      visit_type: "immediate",
      planned_practice: "false",
      planned_exclude_from_analysis: "false",
      planned_visual_duration_ms: "5000",
      planned_audio_onset_ms: "750",
      planned_inter_trial_ms: "650",
      runtime_canonical_response_state: "response_saved",
      runtime_total_attempt_count: "1",
      runtime_noncanonical_attempt_count: "0",
      runtime_client_response_saved_perf_ms: "6130",
      runtime_target_visual_onset_perf_ms: "1028",
      runtime_visual_onset_perf_ms: "1030",
      runtime_onset_late_ms: "2",
      runtime_visibility_interrupted: "false",
    });
    expect(learningCsv).not.toMatch(/participant_name|root_seed|Test Participant/iu);

    // A completed flag alone cannot bypass missing data in an earlier included visit.
    const recording = await env.DB.prepare(`
      SELECT r.attempt_uuid FROM recordings r
      JOIN trial_attempts ta ON ta.attempt_uuid = r.attempt_uuid
      JOIN trial_manifest tm ON tm.trial_uuid = ta.trial_uuid
      WHERE tm.visit_uuid = ? LIMIT 1
    `).bind(created.participant.pre_visit_id).first();
    await env.DB.prepare("UPDATE recordings SET state = 'pending' WHERE attempt_uuid = ?")
      .bind(recording.attempt_uuid).run();
    for (const state of [pre, immediate, delayed]) {
      const incomplete = await jsonRequest("/api/visit/results.zip", { token: state.session_token });
      expect(incomplete.response.status).toBe(409);
      expect(incomplete.json.error.code).toBe("participant_copy_not_ready");
    }
    await env.DB.prepare("UPDATE recordings SET state = 'uploaded' WHERE attempt_uuid = ?")
      .bind(recording.attempt_uuid).run();
    await env.DB.prepare("UPDATE visits SET finalized_at_ms = NULL WHERE visit_uuid = ?")
      .bind(created.participant.pre_visit_id).run();
    for (const state of [pre, immediate, delayed]) {
      const incomplete = await jsonRequest("/api/visit/results.zip", { token: state.session_token });
      expect(incomplete.response.status).toBe(409);
      expect(incomplete.json.error.code).toBe("participant_copy_visits_incomplete");
    }
  }, 60_000);

  it("exports every planned learning trial before responses and leaves canonical runtime fields blank", async () => {
    await createParticipant(902);

    const adminDownload = await request(
      "/api/admin/participants/902/results.zip",
      { token: ADMIN_TOKEN },
    );
    expect(adminDownload.status).toBe(200);
    const entries = parseStoredEntries(await adminDownload.arrayBuffer());
    const responses = JSON.parse(new TextDecoder().decode(entries.get("responses.json")));
    expect(responses.responses).toEqual([]);

    const itemAssignmentsCsvBytes = entries.get("item_assignments.csv");
    expect([...itemAssignmentsCsvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const itemAssignmentLines = new TextDecoder().decode(itemAssignmentsCsvBytes)
      .trimEnd()
      .split("\r\n");
    expect(itemAssignmentLines).toHaveLength(25);

    const learningCsv = new TextDecoder().decode(entries.get("learning_trials.csv"));
    const learningLines = learningCsv.trimEnd().split("\r\n");
    const headers = learningLines[0].split(",");
    const records = learningLines.slice(1).map((line) => {
      const values = line.split(",");
      return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    });
    expect(records).toHaveLength(146);
    expect(records.filter((record) => record.planned_practice === "true")).toHaveLength(2);
    expect(records.every((record) => record.runtime_canonical_attempt_id === "")).toBe(true);
    expect(records.every((record) => record.runtime_canonical_response_state === "")).toBe(true);
    expect(records.every((record) => record.runtime_attempt_no === "")).toBe(true);
    expect(records.every((record) => record.runtime_total_attempt_count === "0")).toBe(true);
    expect(records.every((record) => record.runtime_noncanonical_attempt_count === "0")).toBe(true);
  });

  it("requires authentication for both download routes", async () => {
    const response = await request("/api/admin/participants/901/results.zip");
    expect(response.status).toBe(401);
    expect((await request("/api/visit/results.zip")).status).toBe(401);
    expect((await request("/api/visit/results.zip", { token: "invalid-token" })).status).toBe(401);
  });
});
