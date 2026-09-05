import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  ExperimentApi,
  participantCopyFilename,
} from "../public/js/api.js";
import {
  microphoneCheckStorageKey,
  redirectToCanonical,
  waitForStartOrParticipantExit,
} from "../public/js/flow-guards.js";
import {
  buildDurableTrialRecord,
  canonicalRecordingPayload,
  fullyAcknowledgedAttemptIds,
  isQueuedTrialFullyAcknowledged,
  recordingBlobForDurableQueue,
  saveResponseWithLegacyQualityRepair,
} from "../public/js/outbox.js";
import { analyzeSamples } from "../public/js/audio-engine.js";
import {
  ExperimentRunner,
  isNonRetryableLocalRecordingError,
  isTerminalInterruptionDrainError,
  recordingBlobForPersistence,
} from "../public/js/runner.js";
import {
  countdownState,
  ExperimentUi,
  fatalErrorMessage,
  participantCopyCompletionMessage,
  participantErrorMessage,
  participantGuidanceError,
  participantSupportCode,
  progressState,
  validateBrowserEnvironment,
  visitAvailabilityMessage,
} from "../public/js/ui.js";

function stateWith({ manifest = [], accepted = [] } = {}) {
  return {
    visit: { visit_id: "visit-1", visit_type: "immediate" },
    session: { epoch: 2 },
    manifest,
    accepted,
  };
}

function runnerFor(state, apiOverrides = {}) {
  const api = {
    state: vi.fn().mockResolvedValue(state),
    completeVisit: vi.fn().mockResolvedValue({ ok: true }),
    ...apiOverrides,
  };
  const ui = {
    prompt: vi.fn().mockResolvedValue(undefined),
    setSaveState: vi.fn(),
  };
  const audio = { close: vi.fn() };
  return { runner: new ExperimentRunner(api, ui, audio, state), api, ui, audio };
}

function interactiveElement(overrides = {}) {
  const listeners = new Map();
  const attributes = new Map();
  return {
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    innerHTML: "unchanged-sentinel",
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    focus: vi.fn(),
    setAttribute: vi.fn((name, value) => attributes.set(name, value)),
    removeAttribute: vi.fn((name) => attributes.delete(name)),
    getAttribute: vi.fn((name) => attributes.get(name) ?? null),
    addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    }),
    dispatch(type) {
      listeners.get(type)?.({ preventDefault: vi.fn() });
    },
    ...overrides,
  };
}

function pcm16Wav(samples, sampleRate = 8_000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((character, index) => {
    view.setUint8(offset + index, character.charCodeAt(0));
  });
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
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
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return new Blob([buffer], { type: "audio/wav" });
}

describe("frontend reliability guards", () => {
  it.each(["completed", "started"])("monitors only open visits when reopening %s", (status) => {
    const state = stateWith();
    state.visit.status = status;
    const { runner, api } = runnerFor(state, { heartbeat: vi.fn(async () => ({})) });
    const documentListener = vi.fn();
    const windowListener = vi.fn();
    const interval = vi.fn((tick) => { tick(); return 1; });
    vi.stubGlobal("document", { addEventListener: documentListener });
    vi.stubGlobal("window", { addEventListener: windowListener, setInterval: interval });
    try {
      runner.startMonitoring();
      const count = status === "completed" ? 0 : 1;
      expect(documentListener).toHaveBeenCalledTimes(count);
      expect(windowListener).toHaveBeenCalledTimes(count);
      expect(interval).toHaveBeenCalledTimes(count);
      expect(api.heartbeat).toHaveBeenCalledTimes(count);
      expect(runner.running).toBe(status !== "completed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("measures quality from the same clipped samples written to WAV", () => {
    const quality = analyzeSamples(Float32Array.of(2, -2, 0.5), 48_000);

    expect(quality.peak_amplitude).toBe(1);
    expect(quality.rms_amplitude).toBeCloseTo(Math.sqrt(2.25 / 3), 12);
    expect(quality.clipping_ratio).toBeCloseTo(2 / 3, 12);
  });

  it("repairs legacy WAV quality only after an explicit invalid-payload response", async () => {
    const blob = pcm16Wav([32_767, -32_768, 16_384, 0]);
    const payload = {
      sample_rate_hz: 8_000,
      sample_count: 4,
      duration_seconds: 4 / 8_000,
      quality: {
        analysis_start_seconds: 0,
        analyzed_sample_count: 4,
        rms_amplitude: 2,
        peak_amplitude: 2,
        clipping_ratio: 0,
      },
    };
    const record = {
      trialId: "trial-1",
      attemptId: "attempt-1",
      responseKey: "response-1",
      expectsRecording: true,
      recordingBlob: blob,
      payload,
    };
    const order = [];
    const api = {
      saveResponse: vi.fn(async (...args) => {
        order.push(`send:${args[3].quality.peak_amplitude}`);
        if (order.length === 1) {
          throw Object.assign(new Error("peak_amplitude is outside the accepted range"), {
            status: 422,
            code: "invalid_response_payload",
          });
        }
      }),
    };
    const persist = vi.fn(async () => order.push("persist"));

    await saveResponseWithLegacyQualityRepair(api, record, persist);

    expect(order).toEqual(["send:2", "persist", "send:1"]);
    expect(record.recordingQualityVersion).toBe("pcm16-v1");
    expect(record.payload).toEqual(await canonicalRecordingPayload(blob, payload));
  });

  it("does not rewrite a legacy payload when acknowledgement is uncertain", async () => {
    const payload = { quality: { peak_amplitude: 2 } };
    const record = {
      trialId: "trial-1",
      attemptId: "attempt-1",
      responseKey: "response-1",
      expectsRecording: true,
      recordingBlob: pcm16Wav([0]),
      payload,
    };
    const api = { saveResponse: vi.fn().mockRejectedValue(new TypeError("offline")) };
    const persist = vi.fn();

    await expect(saveResponseWithLegacyQualityRepair(api, record, persist)).rejects.toThrow("offline");
    expect(record.payload).toBe(payload);
    expect(record.recordingQualityVersion).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it("discards practice speech audio while retaining main-trial recording blobs", () => {
    const blob = new Blob(["captured speech"], { type: "audio/wav" });
    const recording = { blob };

    expect(recordingBlobForPersistence({ expects_recording: false }, recording)).toBeNull();
    expect(recordingBlobForPersistence({ expects_recording: true }, recording)).toBe(blob);
    expect(recordingBlobForPersistence({ expects_recording: true }, null)).toBeNull();
  });

  it("rejects an accidentally forwarded practice blob at the durable outbox boundary", async () => {
    const blob = new Blob(["captured speech"], { type: "audio/wav" });

    expect(recordingBlobForDurableQueue(false, blob)).toBeNull();
    expect(recordingBlobForDurableQueue(true, blob)).toBe(blob);
    expect(recordingBlobForDurableQueue(true, null)).toBeNull();
    await expect(buildDurableTrialRecord({
      visitId: "visit-1",
      expectsRecording: false,
      recordingBlob: blob,
      payload: {},
    })).resolves.toMatchObject({
      recordingBlob: null,
      recordingSha256: null,
      recordingAck: true,
    });
  });

  it("does not show the recording indicator before L2 audio onset", async () => {
    const events = [];
    const ui = {
      bindInterruptionControl: vi.fn(),
      showFixation: vi.fn(() => events.push("fixation")),
      setTaskStatus: vi.fn(),
      showAudioCue: vi.fn(() => events.push("audio-cue")),
      setRecording: vi.fn((visible) => events.push(`recording:${visible}`)),
      startResponseTimer: vi.fn(),
    };
    const recording = {
      blob: new Blob(["practice speech"], { type: "audio/wav" }),
      sample_rate_hz: 48_000,
      sample_count: 1,
      duration_seconds: 0,
      start_context_s: -0.15,
      stop_context_s: 0,
      command_stop_perf_ms: 0,
      stopped_perf_ms: 0,
      scheduled_stop_context_s: 0,
      expected_sample_count: 1,
      sample_count_difference: 0,
      missing_input_frames: 0,
      quality: { rms_amplitude: 0.1, peak_amplitude: 0.2, clipping_ratio: 0 },
      microphone_settings: {},
    };
    const audio = {
      startCapture: vi.fn().mockResolvedValue({ start_context_s: -0.15 }),
      playCue: vi.fn(() => ({
        scheduledStartContextS: 0,
        scheduledEndContextS: 0,
        durationS: 0,
        ended: Promise.resolve({ endedPerfMs: 0, endedContextS: 0 }),
      })),
      clockSnapshot: vi.fn(() => ({ performance_time_ms: 0, context_time_s: 0 })),
      stopCaptureAt: vi.fn().mockResolvedValue(recording),
    };
    const runner = new ExperimentRunner({}, ui, audio, {
      visit: { visit_id: "visit-1" },
      manifest: [],
      accepted: [],
    });
    runner.authorizeTrial = vi.fn().mockResolvedValue({ attempt_id: "attempt-1" });
    runner.markTrialStimulusShown = vi.fn().mockResolvedValue(undefined);
    runner.prepareOnset = vi.fn().mockResolvedValue(0);
    runner.requireVisibleBeforeOnset = vi.fn();
    runner.sendEvent = vi.fn().mockResolvedValue(undefined);
    runner.persistTrial = vi.fn().mockResolvedValue(undefined);

    await runner.runL2Trial({
      trial_id: "practice-l2-1",
      expects_recording: false,
      protocol: {
        timing: {
          preAudioRecordingMs: 150,
          responseWindowAfterAudioMs: 10_000,
          interTrialMs: 0,
        },
      },
    }, { cueBuffer: {} });

    const cueIndex = events.indexOf("audio-cue");
    const recordingVisibleIndex = events.indexOf("recording:true");
    expect(cueIndex).toBeGreaterThanOrEqual(0);
    expect(recordingVisibleIndex).toBeGreaterThan(cueIndex);
    expect(events.slice(0, cueIndex)).not.toContain("recording:true");
  });

  it("blocks task start when the effective viewport cannot contain the no-scroll layout", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
      mediaDevices: { getUserMedia: vi.fn() },
    });
    vi.stubGlobal("window", {
      isSecureContext: true,
      indexedDB: {},
      AudioContext: function AudioContext() {},
      AudioWorkletNode: function AudioWorkletNode() {},
      innerWidth: 899,
      innerHeight: 600,
    });
    try {
      expect(validateBrowserEnvironment({ microphone: true })).toContain(
        "課題画面が見切れています。ウィンドウを最大化するか、Chromeのズームを100%に戻してから再読み込みしてください。",
      );
      window.innerWidth = 900;
      expect(validateBrowserEnvironment({ microphone: true })).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("derives countdown text from an absolute deadline without extending after a stalled frame", () => {
    expect(countdownState(20_000, 10_000, 10_000)).toMatchObject({
      remainingSeconds: 10,
      fraction: 1,
    });
    expect(countdownState(20_000, 10_000, 10_001).remainingSeconds).toBe(10);
    expect(countdownState(20_000, 10_000, 11_000).remainingSeconds).toBe(9);
    expect(countdownState(20_000, 10_000, 19_999).remainingSeconds).toBe(1);
    expect(countdownState(20_000, 10_000, 20_000)).toMatchObject({
      remainingSeconds: 0,
      fraction: 0,
    });
    expect(countdownState(20_000, 10_000, 16_000).remainingSeconds).toBe(4);
    expect(countdownState(20_000, 10_000, 21_000).remainingMs).toBe(0);
  });

  it("exposes progress only as a percentage without trial counts", () => {
    expect(progressState("Picture Naming 練習", 0, 2, { inProgress: true })).toMatchObject({
      completed: 0,
      total: 2,
      percent: 0,
      valueText: "進み具合 0パーセント",
    });
    expect(progressState("Picture Naming 練習", 1, 2, { inProgress: true })).toMatchObject({
      completed: 1,
      percent: 50,
      valueText: "進み具合 50パーセント",
    });
    expect(progressState("Picture Naming 本番", 0, 24, { inProgress: true })).toMatchObject({
      completed: 0,
      total: 24,
      valueText: "進み具合 0パーセント",
    });
    const learning = progressState("語彙学習", 24, 144, { inProgress: true });
    expect(learning).toMatchObject({
      completed: 24,
      total: 144,
      valueText: "進み具合 17パーセント",
    });
    expect(progressState("L2-to-L1 本番", 24, 24)).toMatchObject({
      completed: 24,
      percent: 100,
      valueText: "進み具合 100パーセント",
    });
    expect(learning.valueText).not.toMatch(/144|24|\//u);
  });

  it("shows main progress at fixation only and never during practice or a stimulus", () => {
    const ui = Object.create(ExperimentUi.prototype);
    Object.assign(ui, {
      activeImageUrl: null,
      responseTimerFrame: null,
      responseTimerRun: 0,
      stage: interactiveElement({ classList: { remove: vi.fn() } }),
      fixation: interactiveElement({ hidden: true }),
      image: interactiveElement({ hidden: true }),
      emoji: interactiveElement({ hidden: true }),
      placeholder: interactiveElement({ hidden: true }),
      placeholderGloss: interactiveElement(),
      audioCue: interactiveElement({ hidden: true }),
      recording: interactiveElement({ hidden: true }),
      responseTimer: interactiveElement({
        hidden: true,
        classList: { remove: vi.fn() },
      }),
      message: interactiveElement({ hidden: true }),
      promptKeyboardHint: interactiveElement({ hidden: true }),
      continueKeyLabel: interactiveElement({ hidden: true }),
      continueButton: interactiveElement({ hidden: true }),
      downloadLink: interactiveElement({ hidden: true }),
      interruptionChoice: interactiveElement({ hidden: true }),
      interruptionButton: interactiveElement({ hidden: true }),
      progressTrack: interactiveElement({ hidden: true }),
      progressFill: interactiveElement({ style: {} }),
    });

    ui.updateProgress("単語学習 本番", 24, 144, { inProgress: true, practice: false });
    ui.showFixation();
    expect(ui.progressTrack.hidden).toBe(false);
    expect(ui.fixation.hidden).toBe(false);

    ui.showVisual({ protocol: { visualEmoji: "🍎", visualLabel: "りんご" } });
    expect(ui.progressTrack.hidden).toBe(true);
    expect(ui.emoji.hidden).toBe(false);

    ui.updateProgress("phase-without-display-label", 1, 2, { inProgress: true, practice: true });
    ui.showFixation();
    expect(ui.progressTrack.hidden).toBe(true);
    expect(ui.fixation.hidden).toBe(false);
  });

  it("purges a queued trial only after both remote acknowledgements are durable", () => {
    expect(isQueuedTrialFullyAcknowledged({ responseAck: true, recordingAck: true })).toBe(true);
    expect(isQueuedTrialFullyAcknowledged({ responseAck: true, recordingAck: false })).toBe(false);
    expect(isQueuedTrialFullyAcknowledged({ responseAck: false, recordingAck: true })).toBe(false);
    expect(isQueuedTrialFullyAcknowledged(null)).toBe(false);
  });

  it("selects fully acknowledged residue across visits without deleting partial acknowledgements", () => {
    const records = [
      {
        attemptId: "pre-complete",
        visitId: "pre-visit",
        responseAck: true,
        recordingAck: true,
      },
      {
        attemptId: "immediate-response-only",
        visitId: "immediate-visit",
        responseAck: true,
        recordingAck: false,
      },
      {
        attemptId: "delayed-recording-only",
        visitId: "delayed-visit",
        responseAck: false,
        recordingAck: true,
      },
      {
        attemptId: "delayed-complete",
        visitId: "delayed-visit",
        responseAck: true,
        recordingAck: true,
      },
    ];

    expect(fullyAcknowledgedAttemptIds(records)).toEqual([
      "pre-complete",
      "delayed-complete",
    ]);
  });

    it("keeps participant-access markup IDs unique and exposes each step to assistive technology", async () => {
    const response = await exports.default.fetch(
      new Request("https://experiment.test/js/task-page.js"),
    );
    expect(response.status).toBe(200);
    const source = await response.text();
    const ids = [...source.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);

    expect(ids.length).toBeGreaterThan(20);
    expect(new Set(ids).size).toBe(ids.length);
    expect(source).toContain('aria-labelledby="participant-id-heading"');
    expect(source).toContain('aria-labelledby="participant-id-confirmation-heading"');
    expect(source).toContain('id="participant-id-confirmation-heading" tabindex="-1"');
    expect(source).toContain('id="participant-id-confirmation-value" class="summary" aria-live="polite"');
    expect(source).not.toContain('participant-name');
    expect(source).toContain('id="stimulus-emoji"');
    expect(source).toContain('id="prompt-keyboard-hint"');
    expect(source).toContain('id="continue-key-label"');
  });

  it("uses a fresh Space press as the only prompt keyboard shortcut", async () => {
    const listeners = new Map();
    const fakeDocument = {
      body: interactiveElement(),
      addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      }),
    };
    vi.stubGlobal("document", fakeDocument);
    try {
      const ui = Object.create(ExperimentUi.prototype);
      const continueButton = interactiveElement();
      const continueKeyLabel = interactiveElement();
      const interruptionButton = interactiveElement({ hidden: true });
      const stage = interactiveElement();
      Object.assign(ui, {
        resetStage: vi.fn(),
        message: interactiveElement(),
        promptKeyboardHint: interactiveElement(),
        continueKeyLabel,
        continueButton,
        interruptionButton,
        interruptionControlEnabled: true,
        researcherTestMode: false,
        stage,
        activePromptFinish: null,
        spaceHeld: false,
      });

      let resolved = false;
      const pending = ui.prompt("確認", "進む").then(() => { resolved = true; });
      expect(stage.getAttribute("aria-keyshortcuts")).toBe("Space");
      expect(interruptionButton.hidden).toBe(false);
      continueButton.dispatch("click");
      await Promise.resolve();
      expect(resolved).toBe(false);
      const enterEvent = {
        code: "Enter",
        key: "Enter",
        target: stage,
        repeat: false,
        preventDefault: vi.fn(),
      };
      listeners.get("keydown")(enterEvent);
      await Promise.resolve();
      expect(enterEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(false);

      const repeatedSpace = {
        code: "Space",
        key: " ",
        target: stage,
        repeat: true,
        preventDefault: vi.fn(),
      };
      listeners.get("keydown")(repeatedSpace);
      await Promise.resolve();
      expect(resolved).toBe(false);

      const freshSpace = {
        ...repeatedSpace,
        repeat: false,
        preventDefault: vi.fn(),
      };
      listeners.get("keydown")(freshSpace);
      await pending;
      expect(resolved).toBe(true);
      expect(stage.getAttribute("aria-keyshortcuts")).toBe(null);
      expect(continueKeyLabel.textContent).toBe("Space");
      expect(ui.promptKeyboardHint.textContent).toContain("スペースキーを1回押すと「進む」");
      expect(continueButton.addEventListener).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires Space again after cancelling interruption from a safe prompt", async () => {
    const listeners = new Map();
    const stage = interactiveElement();
    const fakeDocument = {
      body: interactiveElement(),
      addEventListener: vi.fn((type, listener) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      }),
    };
    vi.stubGlobal("document", fakeDocument);
    try {
      const ui = Object.create(ExperimentUi.prototype);
      const cancel = interactiveElement();
      Object.assign(ui, {
        resetStage: vi.fn(),
        message: interactiveElement(),
        promptKeyboardHint: interactiveElement(),
        continueKeyLabel: interactiveElement(),
        interruptionButton: interactiveElement({ hidden: true }),
        interruptionControlEnabled: true,
        interruptionButtons: [interactiveElement()],
        interruptionChoiceTitle: interactiveElement(),
        interruptionChoiceDescription: interactiveElement(),
        pauseParticipationButton: interactiveElement(),
        terminateParticipationButton: interactiveElement(),
        cancelInterruptionButton: cancel,
        interruptionChoice: interactiveElement(),
        researcherTestMode: false,
        stage,
        activePromptFinish: null,
        interruptedPrompt: null,
        spaceHeld: false,
      });

      const initialPrompt = ui.prompt("元の課題説明", "本番を開始");
      ui.releaseActivePromptForInterruption();
      await initialPrompt;

      let choiceResolved = false;
      const choice = ui.chooseInterruptionMode().then((value) => {
        choiceResolved = true;
        return value;
      });
      cancel.dispatch("click");
      await Promise.resolve();
      expect(ui.message.textContent).toBe("元の課題説明");
      expect(choiceResolved).toBe(false);

      listeners.get("keydown")({
        code: "Space",
        key: " ",
        target: stage,
        repeat: false,
        preventDefault: vi.fn(),
      });
      await expect(choice).resolves.toBeNull();
      expect(choiceResolved).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("locks the viewport only while the experiment task is active", async () => {
    const [uiResponse, stylesResponse] = await Promise.all([
      exports.default.fetch(new Request("https://experiment.test/js/ui.js")),
      exports.default.fetch(new Request("https://experiment.test/styles.css")),
    ]);
    const uiSource = await uiResponse.text();
    const styles = await stylesResponse.text();
    expect(uiSource).toContain('document.body.classList.add("experiment-active")');
    expect(uiSource).toContain('document.body.classList.remove("experiment-active")');
    expect(styles).toMatch(/body\.experiment-active\s*\{[^}]*overflow:\s*hidden/su);
    expect(styles).toMatch(/body\.experiment-active \.stage\s*\{[^}]*min-height:\s*0/su);
    expect(styles).toMatch(/\.stage\.prompt-active \.stage-message\s*\{[^}]*height:\s*calc\(100% - 146px\)/su);
    expect(uiSource).toContain('this.stage.classList?.add("prompt-active")');
    expect(uiSource).toContain('this.stage.classList?.remove("prompt-active")');
  });

    it("keeps researcher-only timing and storage vocabulary out of participant copy", async () => {
    const paths = [
      "/js/learning.js",
      "/js/segment.js",
      "/js/task-page.js",
      "/js/ui.js",
      "/js/runner.js",
    ];
    const sources = await Promise.all(paths.map(async (path) => {
      const response = await exports.default.fetch(new Request(`https://experiment.test${path}`));
      expect(response.status).toBe(200);
      return response.text();
    }));
    const participantSource = sources.join("\n");

    expect(participantSource).not.toMatch(/750ミリ秒|研究用サーバー|server受付済み|日本語の練習|日本語音声/u);
    expect(sources[0]).toContain("最初に短い練習をします");
    expect(sources[0]).toContain("英単語の音声");
    expect(sources[1]).toContain("絵を見て英単語を答える課題");
    expect(sources[1]).toContain("英語を聞いて日本語で答える課題");
    expect(sources[1]).toContain("やさしい英単語");
    expect(sources[1]).not.toContain("本番には出ない");
    expect(sources[1]).toContain("分かった時点ですぐに");
    expect(sources[1]).not.toContain("reviewPracticeRecording");
  });

  it("does not expose raw internal errors to participants", () => {
    expect(participantErrorMessage(new Error("IndexedDB transaction aborted")))
      .not.toContain("IndexedDB");
    expect(participantErrorMessage(new Error("Internal API manifest mismatch")))
      .not.toContain("manifest");
    expect(participantErrorMessage(new Error("学習音声が5秒の提示窓に収まりません")))
      .not.toContain("5秒の提示窓");
    expect(participantErrorMessage(new Error("録音中に音声frameの欠落を検出しました")))
      .not.toContain("frame");
    expect(participantErrorMessage(new Error("中断リクエストの確認情報が一致しません")))
      .not.toContain("リクエスト");
    const internal = { code: "local_recording_missing" };
    expect(participantSupportCode(internal)).toMatch(/^E-[0-9A-Z]{7}$/u);
    expect(participantSupportCode(internal)).not.toContain(internal.code);
    expect(participantErrorMessage(participantGuidanceError("パソコン版Google Chromeで開いてください。")))
      .toBe("パソコン版Google Chromeで開いてください。");
  });

  it("formats the server admission time in JST without rounding it down", () => {
    for (const [availableAt, label] of [
      [1893553200980, "2030年1月2日水曜日 12:00:01"],
      [1893553200000, "2030年1月2日水曜日 12:00:00"],
      [Date.UTC(2026, 8, 30, 14, 59, 59, 999), "2026年10月1日木曜日 00:00:00"],
    ]) {
      const error = new ApiClientError(403, "visit_not_available", "internal", {
        available_at_ms: availableAt, server_now_ms: availableAt - 1,
      });
      const message = visitAvailabilityMessage(error);
      expect(message).toContain(`${label}（日本時間）以降`);
      expect(message).toContain("同じ参加者ID");
      expect(message).toContain("自動では始まりません");
      expect(error.details.available_at_ms).toBe(availableAt);
    }
    for (const details of [null, {},
      { available_at_ms: "1893553200980", server_now_ms: 1 },
      { available_at_ms: Infinity, server_now_ms: 1 },
      { available_at_ms: Number.MAX_SAFE_INTEGER, server_now_ms: 1 },
      { available_at_ms: 10, server_now_ms: null },
      { available_at_ms: 10, server_now_ms: 0 },
      { available_at_ms: 10, server_now_ms: 10 },
      { available_at_ms: 10, server_now_ms: 11 },
    ]) {
      expect(visitAvailabilityMessage(new ApiClientError(403, "visit_not_available", "internal", details)))
        .toBeNull();
    }
    expect(visitAvailabilityMessage(new ApiClientError(500, "visit_not_available", "internal", {
      available_at_ms: 10, server_now_ms: 1,
    }))).toBeNull();
  });

  it("uses a neutral scheduled-visit card without hiding real errors or interruption uncertainty", () => {
    vi.stubGlobal("document", { body: { classList: { remove: vi.fn() } } });
    try {
      const ui = Object.create(ExperimentUi.prototype);
      Object.assign(ui, {
        researcherTestMode: false, stopResponseTimer: vi.fn(),
        welcome: interactiveElement(), task: interactiveElement(),
        fatalPanel: interactiveElement(), fatalTitle: interactiveElement(),
        fatalMessage: interactiveElement(), fatalReload: interactiveElement(),
        fatalHelp: interactiveElement(),
      });
      const error = new ApiClientError(403, "visit_not_available", "internal", {
        available_at_ms: 1893553200980, server_now_ms: 1893553200979,
      });
      ui.fatal(error);
      expect(ui.fatalTitle.textContent).toBe("まだ開始時刻になっていません");
      expect(ui.fatalPanel.classList.toggle).toHaveBeenLastCalledWith("error-card", false);
      expect(ui.fatalPanel.getAttribute("role")).toBe("region");
      expect(ui.fatalMessage.textContent).toContain("12:00:01（日本時間）以降");
      expect(ui.fatalMessage.textContent).not.toContain("お問い合わせ番号");
      expect(ui.fatalReload.hidden).toBe(false);
      expect(ui.fatalReload.textContent).toBe("受付状況を確認する");
      expect(ui.fatalPanel.focus).toHaveBeenCalledTimes(1);
      expect(ui.welcome.hidden && ui.task.hidden).toBe(true);

      ui.fatal(error, { interruptionRequested: true });
      expect(ui.fatalMessage.textContent).toContain("どれが完了したか確認できていません");
      expect(ui.fatalPanel.getAttribute("role")).toBe("alert");
      ui.fatal(new ApiClientError(403, "visit_not_available", "internal"));
      expect(ui.fatalTitle.textContent).toBe("課題を続行できません");
      expect(ui.fatalMessage.textContent).toContain("お問い合わせ番号");
      expect(ui.fatalReload.hidden).toBe(true);
      ui.researcherTestMode = true;
      ui.fatal(error);
      expect(ui.fatalPanel.classList.toggle).toHaveBeenLastCalledWith("error-card", true);
      expect(ui.fatalMessage.textContent).toContain("研究者用動作確認");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives both visibility paths the same stable, noncommittal recovery", () => {
    const { runner } = runnerFor(stateWith());
    let interruptionError;
    try {
      runner.stopIfVisibilityInterrupted(true);
    } catch (error) {
      interruptionError = error;
    }
    expect(interruptionError).toMatchObject({ code: "trial_visibility_interrupted" });
    const message = participantErrorMessage(interruptionError);
    expect(message).toContain("この回の保存状態は、この画面では確認できません");
    expect(message).toContain("同じ参加者ID");
    expect(message).toContain("サーバーで確認できた位置から再開");
    expect(message).not.toContain("記録済み");

    vi.stubGlobal("document", { visibilityState: "hidden" });
    try {
      expect(() => runner.requireVisibleBeforeOnset())
        .toThrow(expect.objectContaining({ code: "trial_visibility_interrupted" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the same-page reload action only for a recoverable participant interruption", () => {
    vi.stubGlobal("document", {
      body: { classList: { remove: vi.fn() } },
      visibilityState: "hidden",
    });
    try {
      const ui = Object.create(ExperimentUi.prototype);
      Object.assign(ui, {
        researcherTestMode: false,
        stopResponseTimer: vi.fn(),
        welcome: interactiveElement(),
        task: interactiveElement(),
        fatalPanel: interactiveElement(),
        fatalTitle: interactiveElement(),
        fatalMessage: interactiveElement(),
        fatalReload: interactiveElement({ hidden: true }),
        fatalHelp: interactiveElement(),
      });
      const { runner } = runnerFor(stateWith());
      let interruptionError;
      try {
        runner.requireVisibleBeforeOnset();
      } catch (error) {
        interruptionError = error;
      }
      ui.fatal(interruptionError);

      expect(ui.fatalReload.hidden).toBe(false);
      expect(ui.fatalReload.textContent).toBe("同じ課題を開き直す");
      expect(ui.fatalMessage.textContent).toContain("同じ参加者ID");
      expect(ui.fatalHelp.textContent).toContain("開き直せない場合");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders an opaque inquiry number instead of a raw error code on the fatal screen", () => {
    vi.stubGlobal("document", {
      body: { classList: { remove: vi.fn() } },
    });
    try {
      const ui = Object.create(ExperimentUi.prototype);
      Object.assign(ui, {
        stopResponseTimer: vi.fn(),
        welcome: interactiveElement(),
        task: interactiveElement(),
        fatalPanel: interactiveElement(),
        fatalTitle: interactiveElement(),
        fatalMessage: interactiveElement(),
      });
      ui.fatal({
        code: "session_superseded",
        message: "Internal session epoch mismatch",
      });
      expect(ui.fatalMessage.textContent).toContain("お問い合わせ番号: E-");
      expect(ui.fatalMessage.textContent).not.toContain("session_superseded");
      expect(ui.fatalMessage.textContent).not.toContain("epoch mismatch");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("makes the safe action the default in a partial-data termination warning", async () => {
    const ui = Object.create(ExperimentUi.prototype);
    const terminate = interactiveElement();
    const cancel = interactiveElement();
    Object.assign(ui, {
      resetStage: vi.fn(),
      setInterruptionControlEnabled: vi.fn(),
      interruptionChoiceTitle: interactiveElement(),
      interruptionChoiceDescription: interactiveElement(),
      pauseParticipationButton: interactiveElement(),
      terminateParticipationButton: terminate,
      cancelInterruptionButton: cancel,
      interruptionChoice: interactiveElement(),
    });

    const choice = ui.confirmTerminationWithPartialData();
    expect(cancel.focus).toHaveBeenCalledTimes(1);
    expect(ui.interruptionChoiceDescription.textContent).toContain("一部の回答または録音を保存できません");
    cancel.dispatch("click");
    await expect(choice).resolves.toBe(false);
  });

  it("shows participant-facing Japanese guidance for common server errors", () => {
    expect(participantErrorMessage({
      code: "development_participants_blocked",
      message: "Development participant access is disabled",
    })).toContain("通常の参加者ID");
    expect(participantErrorMessage({
      code: "session_superseded",
      message: "This session is no longer active",
    })).toContain("別のタブ");
    expect(participantErrorMessage({
      code: "invalid_response_payload",
      message: "visual_onset_perf_ms is outside the accepted range",
    })).toContain("整合性");
    expect(participantErrorMessage({
      code: "session_expired",
      message: "The session expired",
    })).toContain("回答期限ではありません");
    expect(participantErrorMessage({
      code: "participant_copy_session_expired",
      message: "The session expired",
    })).toContain("担当者へ依頼");
    expect(participantErrorMessage({
      code: "invalid_response_payload",
      message: "invalid response",
    })).not.toContain("閉じない");
    const missingRecording = participantErrorMessage({
      code: "local_recording_missing",
      message: "recording missing",
    });
    expect(missingRecording).toContain("完了しておらず");
    expect(missingRecording).toContain("参加終了を選ばず停止");
    expect(missingRecording).toContain("担当者");
  });

  it("does not imply completion or server receipt when a trial fails after interruption was requested", () => {
    const message = fatalErrorMessage(
      { code: "invalid_response_payload", message: "invalid response" },
      { interruptionRequested: true },
    );

    expect(message).toContain("通常完了、一時中断、参加終了のどれが完了したか確認できていません");
    expect(message).toContain("どこまで保存されたかも確認できていません");
    expect(message).toContain("同じ課題ページを開き直し");
    expect(message).toContain("参加者IDを入力");
    expect(message).toContain("新しい問題を始める前に「中断・終了」");
    expect(message).toContain("担当者へ連絡");
    expect(message).not.toContain("保存は完了");
    expect(message).not.toContain("サーバー受付済み");
    expect(fatalErrorMessage(
      { code: "participant_copy_session_expired", message: "The session expired" },
      { interruptionRequested: true },
    )).not.toContain("研究用サーバーに保存済み");
    expect(fatalErrorMessage(
      { code: "invalid_response_payload", message: "invalid response" },
    )).not.toContain("同じ有効な招待リンク");
  });

  it("returns to the welcome screen after cancelling an interruption without auto-starting", async () => {
    const ui = {
      waitForStart: vi.fn()
        .mockResolvedValueOnce("interrupt")
        .mockResolvedValueOnce("start"),
      beginTask: vi.fn(),
      returnToWelcome: vi.fn(),
    };
    const runner = { handleParticipantExit: vi.fn().mockResolvedValue(false) };

    await expect(waitForStartOrParticipantExit(ui, runner)).resolves.toBeUndefined();
    expect(ui.waitForStart).toHaveBeenCalledTimes(2);
    expect(ui.beginTask).toHaveBeenCalledTimes(1);
    expect(runner.handleParticipantExit).toHaveBeenCalledTimes(1);
    expect(ui.returnToWelcome).toHaveBeenCalledTimes(1);
  });

  it("stops monitoring and closes audio before a post-start canonical redirect", () => {
    const calls = [];
    const redirected = redirectToCanonical(
      { next_route: "/immediate-l2-to-l1/" },
      {
        runner: { stopMonitoring: () => calls.push("stop") },
        audio: { close: () => calls.push("close") },
        location: {
          pathname: "/immediate-picture-naming/",
          replace: (path) => calls.push(`replace:${path}`),
        },
      },
    );

    expect(redirected).toBe(true);
    expect(calls).toEqual([
      "stop",
      "close",
      "replace:/immediate-l2-to-l1/",
    ]);
  });

  it("does not stop a running task when the current route is already canonical", () => {
    const stopMonitoring = vi.fn();
    const close = vi.fn();
    const replace = vi.fn();
    const redirected = redirectToCanonical(
      { next_route: "/immediate-picture-naming/" },
      {
        runner: { stopMonitoring },
        audio: { close },
        location: { pathname: "/immediate-picture-naming", replace },
      },
    );

    expect(redirected).toBe(false);
    expect(stopMonitoring).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("uses separate microphone checks for Picture Naming and L2-to-L1", () => {
    const state = stateWith();
    const pictureKey = microphoneCheckStorageKey(state, "picture_naming");
    const l2Key = microphoneCheckStorageKey(state, "l2_to_l1");

    expect(pictureKey).toBe("microphone_checked:visit-1:2:picture_naming");
    expect(l2Key).toBe("microphone_checked:visit-1:2:l2_to_l1");
    expect(pictureKey).not.toBe(l2Key);
  });

  it("retries a rejected speculative preload exactly once as a foreground load", async () => {
    const state = stateWith();
    const { runner } = runnerFor(state);
    const trial = { trial_id: "trial-1" };
    const loaded = { cueBuffer: "loaded", imageUrl: null };
    runner.preloadedTrials.set(trial.trial_id, Promise.reject(new Error("transient preload failure")));
    runner.loadTrialAssets = vi.fn().mockResolvedValue(loaded);

    await expect(runner.preloadTrial(trial)).resolves.toBe(loaded);
    expect(runner.loadTrialAssets).toHaveBeenCalledTimes(1);
    expect(runner.preloadedTrials.has(trial.trial_id)).toBe(false);
  });

  it("does not loop if the one foreground preload retry also fails", async () => {
    const state = stateWith();
    const { runner } = runnerFor(state);
    const trial = { trial_id: "trial-2" };
    runner.preloadedTrials.set(trial.trial_id, Promise.reject(new Error("speculative failure")));
    runner.loadTrialAssets = vi.fn().mockRejectedValue(new Error("foreground failure"));

    await expect(runner.preloadTrial(trial)).rejects.toThrow("foreground failure");
    expect(runner.loadTrialAssets).toHaveBeenCalledTimes(1);
  });

  it("retries visit finalization after a transient transport failure", async () => {
    const state = stateWith();
    const completeVisit = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary network failure"))
      .mockResolvedValue({ ok: true });
    const { runner, ui } = runnerFor(state, { completeVisit });

    await expect(runner.completeVisitWithRetry()).resolves.toEqual({ ok: true });
    expect(completeVisit).toHaveBeenCalledTimes(2);
    expect(ui.prompt).toHaveBeenCalledTimes(1);
  });

  it("uses one safe filename for the single participant ZIP", () => {
    expect(participantCopyFilename('attachment; filename="accentedness_results.zip"'))
      .toBe("accentedness_results.zip");
    expect(participantCopyFilename('attachment; filename="../../unsafe.zip"'))
      .toBe("accentedness_results.zip");
  });

  it("describes automatic download without claiming a completed disk save", () => {
    const message = participantCopyCompletionMessage({
      alreadyCompleted: true, filename: "accentedness_p901_20260905.zip",
    });
    expect(message).toContain("回答と録音も保存済み");
    expect(message).toContain("自動ダウンロードを開始");
    expect(message).toContain("Chromeのダウンロード一覧");
    expect(message).toContain("accentedness_p901_20260905.zip");
    expect(message).toContain("参加者IDと録音");
    expect(message).not.toContain("ZIP書き込みも完了");
    expect(participantCopyCompletionMessage({ filename: "../../unsafe.zip" }))
      .toContain("accentedness_results.zip");
  });

  it.each([
    ["pre", "事前テスト", "単語学習のリンク"],
    ["immediate", "直後テスト", "遅延テストの案内"],
    ["delayed", "遅延テスト", "ご協力ありがとうございました"],
  ])("gives %s-specific download and next-step guidance", (visitType, label, nextStep) => {
    for (const alreadyCompleted of [false, true]) {
      const message = participantCopyCompletionMessage({ visitType, alreadyCompleted });
      expect(message).toContain(label);
      expect(message).toContain(nextStep);
      expect(message).toContain("ここまでの回答と録音");
      expect(message).toContain("自動ダウンロードを開始");
      expect(message.includes("録音を聞き返したりせず")).toBe(visitType !== "delayed");
    }
  });

  it("automatically clicks the named ZIP link and keeps it available for manual retry", () => {
    const blob = new Blob(["zip"]);
    const filename = "accentedness_p901_20260905.zip";
    const link = interactiveElement();
    link.click = vi.fn(() => {
      expect(link.download).toBe(filename);
      expect(link.href).toBe("blob:synthetic-copy");
      expect(link.hidden).toBe(false);
    });
    const ui = { resetStage: vi.fn(), activeDownloadUrl: "blob:old-copy", downloadLink: link };
    const createObjectURL = vi.fn(() => "blob:synthetic-copy");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    try {
      ExperimentUi.prototype.downloadParticipantCopy.call(ui, { blob, filename });
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:old-copy");
      expect(link.click).toHaveBeenCalledTimes(1);
      expect(link.textContent).toBe("ZIPをもう一度ダウンロード");
      link.click();
      expect(link.click).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([3, 5])("checks complete ZIP reception before download (expected bytes: %s)", async (expectedBytes) => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(expectedBytes),
        "Content-Disposition": 'attachment; filename="accentedness_p901_20260905.zip"',
      },
    });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    try {
      const result = ExperimentApi.prototype.fetchParticipantCopy.call({ sessionToken: "local-test" });
      if (expectedBytes === 3) {
        await expect(result).resolves.toMatchObject({
          filename: "accentedness_p901_20260905.zip", byteCount: 3,
        });
      } else {
        await expect(result).rejects.toThrow("最後まで受信");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries participant ZIP preparation without changing visit completion", async () => {
    const state = stateWith();
    const fetchParticipantCopy = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary copy failure"))
      .mockResolvedValue({ blob: new Blob(["zip"]), filename: "accentedness_results.zip" });
    const { runner, ui } = runnerFor(state, { fetchParticipantCopy });

    await expect(runner.prepareParticipantCopyWithRetry()).resolves.toMatchObject({
      filename: "accentedness_results.zip",
    });
    expect(fetchParticipantCopy).toHaveBeenCalledTimes(2);
    expect(fetchParticipantCopy).toHaveBeenNthCalledWith(1);
    expect(fetchParticipantCopy).toHaveBeenNthCalledWith(2);
    expect(ui.prompt).toHaveBeenCalledWith(
      expect.stringContaining("実験データは保存されています"),
      "ZIPを再準備する",
    );
  });

  it("stops ZIP retries with accurate guidance after the completed session expires", async () => {
    const state = stateWith();
    const fetchParticipantCopy = vi.fn().mockRejectedValue(
      new ApiClientError(401, "session_expired", "The session expired"),
    );
    const { runner, ui } = runnerFor(state, { fetchParticipantCopy });

    await expect(runner.prepareParticipantCopyWithRetry()).rejects.toMatchObject({
      code: "participant_copy_session_expired",
      status: 401,
    });
    expect(fetchParticipantCopy).toHaveBeenCalledTimes(1);
    expect(ui.prompt).not.toHaveBeenCalled();
  });

  it("keeps a durably queued trial in place and retries a transient response PUT", async () => {
    const state = stateWith();
    const { runner, ui, api } = runnerFor(state);
    const acknowledge = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary response failure"))
      .mockResolvedValue({ responseAck: true });

    await expect(
      runner.acknowledgeTrialResponseWithRetry("attempt-1", acknowledge),
    ).resolves.toEqual({ responseAck: true });
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenNthCalledWith(1, api, "attempt-1");
    expect(acknowledge).toHaveBeenNthCalledWith(2, api, "attempt-1");
    expect(ui.setSaveState).toHaveBeenCalledWith("queued");
    expect(ui.prompt).toHaveBeenCalledWith(
      expect.stringContaining("この回の回答をまだ保存できていません"),
      "回答を再送する",
    );
  });

  it("fails before another trial when an accepted WAV is absent locally and remotely", async () => {
    const state = stateWith({
      manifest: [{ trial_id: "trial-recorded", expects_recording: true }],
      accepted: [{
        trial_id: "trial-recorded",
        attempt_id: "attempt-recorded",
        recording_state: "pending",
      }],
    });
    const { runner } = runnerFor(state);
    runner.flushWithRetry = vi.fn().mockResolvedValue(undefined);
    const hasQueuedRecording = vi.fn().mockResolvedValue(false);

    await expect(runner.reconcileOutbox(hasQueuedRecording)).rejects.toMatchObject({
      code: "local_recording_missing",
      details: {
        trial_id: "trial-recorded",
        attempt_id: "attempt-recorded",
      },
    });
    expect(hasQueuedRecording).toHaveBeenCalledWith("visit-1", "attempt-recorded");
  });

  it("offers canonical partial-data termination when a missing accepted WAV makes resume unsafe", async () => {
    const state = stateWith({
      manifest: [{ trial_id: "trial-recorded", expects_recording: true }],
      accepted: [{
        trial_id: "trial-recorded",
        attempt_id: "attempt-recorded",
        recording_state: "pending",
      }],
    });
    const recordingError = Object.assign(new Error("recording missing"), {
      code: "local_recording_missing",
    });
    const interruptionId = "77777777-7777-4777-8777-777777777777";
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const finalizeParticipationInterruption = vi.fn().mockResolvedValue({
      interruption: { state: "terminated" },
    });
    const clearSession = vi.fn();
    const { runner, ui } = runnerFor(state, {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseTerminationAfterUnsafeResume: vi.fn().mockResolvedValue(true),
      chooseInterruptionMode: vi.fn(),
      setInterruptionPending: vi.fn(),
      showInterruptionWorking: vi.fn(),
      confirmTerminationWithPartialData: vi.fn().mockResolvedValue(undefined),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.flushWithRetry = vi.fn().mockResolvedValue(undefined);
    runner.unrecoverableAcceptedRecordingError = vi.fn().mockResolvedValue(recordingError);

    await expect(runner.reconcileOutbox()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: true,
    });
    expect(ui.chooseTerminationAfterUnsafeResume)
      .toHaveBeenCalledWith(recordingError);
    expect(ui.chooseInterruptionMode).not.toHaveBeenCalled();
    expect(requestParticipationInterruption).toHaveBeenCalledWith(
      "terminate",
      expect.any(String),
    );
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(finalizeParticipationInterruption).toHaveBeenCalledWith(
      interruptionId,
      requestId,
    );
    expect(ui.confirmTerminationWithPartialData).toHaveBeenCalledTimes(1);
    expect(ui.interrupted).toHaveBeenCalledWith("terminate", { partialData: true });
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["corrupt Blob", () => Object.assign(new Error("invalid local WAV"), {
      code: "client_recording_preflight_failed",
    })],
    ["unreadable IndexedDB", () => new DOMException("record unreadable", "DataError")],
  ])("offers the same termination-only recovery when outbox flush fails on %s", async (_, errorFactory) => {
    const interruptionId = "88888888-8888-4888-8888-888888888888";
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const finalizeParticipationInterruption = vi.fn().mockResolvedValue({
      interruption: { state: "terminated" },
    });
    const clearSession = vi.fn();
    const { runner, ui, api } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    const recordingError = errorFactory();
    Object.assign(ui, {
      chooseTerminationAfterUnsafeResume: vi.fn().mockResolvedValue(true),
      chooseInterruptionMode: vi.fn(),
      setInterruptionPending: vi.fn(),
      showInterruptionWorking: vi.fn(),
      confirmTerminationWithPartialData: vi.fn().mockResolvedValue(undefined),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.flushWithRetry = vi.fn().mockRejectedValue(recordingError);

    await expect(runner.reconcileOutbox()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: true,
    });
    expect(ui.chooseTerminationAfterUnsafeResume)
      .toHaveBeenCalledWith(recordingError);
    expect(ui.chooseInterruptionMode).not.toHaveBeenCalled();
    expect(requestParticipationInterruption).toHaveBeenCalledWith(
      "terminate",
      expect.any(String),
    );
    expect(ui.confirmTerminationWithPartialData).toHaveBeenCalledTimes(1);
    expect(finalizeParticipationInterruption).toHaveBeenCalledTimes(1);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(api.state).not.toHaveBeenCalled();
  });

  it("allows reconciliation when every accepted recording is uploaded", async () => {
    const state = stateWith({
      manifest: [{ trial_id: "trial-recorded", expects_recording: true }],
      accepted: [{
        trial_id: "trial-recorded",
        attempt_id: "attempt-recorded",
        recording_state: "uploaded",
      }],
    });
    const { runner } = runnerFor(state);
    runner.flushWithRetry = vi.fn().mockResolvedValue(undefined);
    const hasQueuedRecording = vi.fn();

    await expect(runner.reconcileOutbox(hasQueuedRecording)).resolves.toBe(state);
    expect(hasQueuedRecording).not.toHaveBeenCalled();
  });

  it("warns on unload only while the running task has unsaved work", () => {
    const { runner } = runnerFor(stateWith());
    runner.running = true;
    const cleanEvent = { preventDefault: vi.fn(), returnValue: null };

    runner.onBeforeUnload(cleanEvent);
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();

    runner.trialInFlight = true;
    const trialEvent = { preventDefault: vi.fn(), returnValue: null };
    runner.onBeforeUnload(trialEvent);
    expect(trialEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(trialEvent.returnValue).toBe("");

    runner.trialInFlight = false;
    runner.backgroundUploadFailed = true;
    const queuedEvent = { preventDefault: vi.fn(), returnValue: null };
    runner.onBeforeUnload(queuedEvent);
    expect(queuedEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("classifies non-retryable missing or corrupt recordings without treating network failures as local corruption", () => {
    for (const code of [
      "client_recording_preflight_failed",
      "local_recording_missing",
      "local_recording_unreadable",
      "invalid_wav",
      "recording_checksum_mismatch",
      "recording_payload_mismatch",
    ]) {
      expect(isNonRetryableLocalRecordingError({ code })).toBe(true);
    }
    expect(isNonRetryableLocalRecordingError(
      new DOMException("IndexedDB record is unreadable", "DataError"),
    )).toBe(true);
    expect(isNonRetryableLocalRecordingError(new TypeError("offline"))).toBe(false);
    expect(isNonRetryableLocalRecordingError({ code: "invalid_response_payload" })).toBe(false);
  });

  it("allows terminal response or recording 4xx errors to end participation but not auth or retryable failures", () => {
    for (const error of [
      { status: 409, code: "recording_object_conflict" },
      { status: 409, code: "idempotency_conflict" },
      { status: 422, code: "invalid_response_payload" },
      { status: 422, code: "recording_payload_mismatch" },
    ]) {
      expect(isTerminalInterruptionDrainError(error)).toBe(true);
    }
    for (const error of [
      { status: 401, code: "session_expired" },
      { status: 401, code: "authorization_required" },
      { status: 409, code: "session_superseded" },
      { status: 409, code: "visit_closed" },
      { status: 429, code: "temporarily_unavailable" },
      { status: 503, code: "temporarily_unavailable" },
      new TypeError("offline"),
    ]) {
      expect(isTerminalInterruptionDrainError(error)).toBe(false);
    }
  });

  it("canonically terminates with an explicit partial-data warning when a local recording cannot drain", async () => {
    const interruptionId = "22222222-2222-4222-8222-222222222222";
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const finalizeParticipationInterruption = vi.fn().mockResolvedValue({
      interruption: { state: "terminated" },
    });
    const clearSession = vi.fn();
    const { runner, ui, api } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseInterruptionMode: vi.fn().mockResolvedValue("terminate"),
      showInterruptionWorking: vi.fn(),
      confirmTerminationWithPartialData: vi.fn().mockResolvedValue(undefined),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.participantExitRequested = true;
    runner.flushWithRetry = vi.fn().mockRejectedValue(
      Object.assign(new Error("recording missing"), { code: "local_recording_missing" }),
    );

    await expect(runner.handleParticipantExit()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: true,
    });
    expect(requestParticipationInterruption).toHaveBeenCalledWith(
      "terminate",
      expect.any(String),
    );
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(ui.confirmTerminationWithPartialData).toHaveBeenCalledTimes(1);
    expect(finalizeParticipationInterruption).toHaveBeenCalledWith(interruptionId, requestId);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(ui.interrupted).toHaveBeenCalledWith("terminate", { partialData: true });
    expect(api.completeVisit).not.toHaveBeenCalled();
  });

  it("does not finalize partial-data termination without an explicit click confirmation", async () => {
    const interruptionId = "23232323-2323-4232-8232-232323232323";
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const finalizeParticipationInterruption = vi.fn();
    const clearSession = vi.fn();
    const { runner, ui } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseInterruptionMode: vi.fn().mockResolvedValue("terminate"),
      confirmTerminationWithPartialData: vi.fn().mockResolvedValue(false),
      interruptionUnconfirmed: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.participantExitRequested = true;
    runner.flushWithRetry = vi.fn().mockRejectedValue(
      Object.assign(new Error("recording missing"), { code: "local_recording_missing" }),
    );

    await expect(runner.handleParticipantExit()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: false,
    });
    expect(finalizeParticipationInterruption).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(ui.interruptionUnconfirmed).toHaveBeenCalledWith("terminate", requestId);
  });

  it("does not finalize a pause when a local recording is missing", async () => {
    const interruptionId = "44444444-4444-4444-8444-444444444444";
    const finalizeParticipationInterruption = vi.fn();
    const clearSession = vi.fn();
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const { runner, ui } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseInterruptionMode: vi.fn().mockResolvedValue("pause"),
      chooseTerminationAfterUnsafePause: vi.fn().mockResolvedValue(false),
      showInterruptionWorking: vi.fn(),
      interruptionUnconfirmed: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.participantExitRequested = true;
    runner.flushWithRetry = vi.fn().mockRejectedValue(
      Object.assign(new Error("recording missing"), { code: "local_recording_missing" }),
    );

    await expect(runner.handleParticipantExit()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "pause",
      confirmed: false,
    });
    expect(finalizeParticipationInterruption).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(ui.interruptionUnconfirmed).toHaveBeenCalledWith("pause", requestId);
  });

  it("changes an unsafe pause request to termination with the same durable request ID", async () => {
    const interruptionId = "55555555-5555-4555-8555-555555555555";
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      escalated: mode === "terminate",
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const finalizeParticipationInterruption = vi.fn().mockResolvedValue({
      interruption: { state: "terminated" },
    });
    const clearSession = vi.fn();
    const { runner, ui } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseInterruptionMode: vi.fn().mockResolvedValue("pause"),
      chooseTerminationAfterUnsafePause: vi.fn().mockResolvedValue(true),
      showInterruptionWorking: vi.fn(),
      confirmTerminationWithPartialData: vi.fn().mockResolvedValue(undefined),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.participantExitRequested = true;
    runner.flushWithRetry = vi.fn().mockRejectedValue(
      Object.assign(new Error("response cannot be accepted"), {
        status: 422,
        code: "invalid_response_payload",
      }),
    );

    await expect(runner.handleParticipantExit()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: true,
    });
    expect(requestParticipationInterruption).toHaveBeenCalledTimes(2);
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(requestParticipationInterruption.mock.calls).toEqual([
      ["pause", requestId],
      ["terminate", requestId],
    ]);
    expect(ui.chooseTerminationAfterUnsafePause).toHaveBeenCalledTimes(1);
    expect(ui.confirmTerminationWithPartialData).toHaveBeenCalledTimes(1);
    expect(finalizeParticipationInterruption).toHaveBeenCalledWith(
      interruptionId,
      requestId,
    );
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(ui.interrupted).toHaveBeenCalledWith("terminate", { partialData: true });
  });

  it("lets a participant stop retrying a transient finalize failure without claiming termination", async () => {
    const interruptionId = "66666666-6666-4666-8666-666666666666";
    const finalizeParticipationInterruption = vi.fn().mockRejectedValue(
      new TypeError("offline"),
    );
    const clearSession = vi.fn();
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const { runner, ui } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseInterruptionMode: vi.fn().mockResolvedValue("terminate"),
      showInterruptionWorking: vi.fn(),
      retryInterruptionOrShowCloseGuidance: vi.fn().mockResolvedValue(false),
      interruptionUnconfirmed: vi.fn(),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.participantExitRequested = true;
    runner.flushWithRetry = vi.fn().mockResolvedValue(undefined);

    await expect(runner.handleParticipantExit()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: false,
    });
    expect(finalizeParticipationInterruption).toHaveBeenCalledTimes(1);
    expect(ui.retryInterruptionOrShowCloseGuidance).toHaveBeenCalledTimes(1);
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(ui.interruptionUnconfirmed).toHaveBeenCalledWith("terminate", requestId);
    expect(ui.interrupted).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });
});
