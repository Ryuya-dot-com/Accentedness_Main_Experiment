import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  canonicalizeParticipantNameForDisplay,
  consumeInvitationToken,
  ExperimentApi,
  invitationRedeemPayload,
  isCorrectableParticipantAccessError,
  isCorrectableParticipantNameError,
  ParticipantNameValidationError,
  participantCopyFilename,
  participantNamePreviewPayload,
  validateParticipantNameForRegistration,
  writeResponseToFile,
} from "../public/js/api.js";
import {
  bootstrapWithParticipantAccess,
  microphoneCheckStorageKey,
  redirectToCanonical,
  waitForStartOrParticipantExit,
} from "../public/js/flow-guards.js";
import {
  fullyAcknowledgedAttemptIds,
  isQueuedTrialFullyAcknowledged,
} from "../public/js/outbox.js";
import {
  ExperimentRunner,
  isNonRetryableLocalRecordingError,
  isTerminalInterruptionDrainError,
} from "../public/js/runner.js";
import {
  countdownState,
  ExperimentUi,
  fatalErrorMessage,
  PARTICIPANT_COPY_DELIVERY,
  participantCopyCompletionMessage,
  participantErrorMessage,
  participantGuidanceError,
  participantSupportCode,
  progressState,
  validateBrowserEnvironment,
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

describe("frontend reliability guards", () => {
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

  it("separates the current trial position from durably completed progress", () => {
    expect(progressState("Picture Naming 練習", 0, 2, { inProgress: true })).toMatchObject({
      completed: 0,
      position: 1,
      total: 2,
      percent: 0,
      labelText: "Picture Naming 練習　1/2 回目",
    });
    expect(progressState("Picture Naming 練習", 1, 2, { inProgress: true })).toMatchObject({
      completed: 1,
      position: 2,
      percent: 50,
      labelText: "Picture Naming 練習　2/2 回目",
    });
    expect(progressState("Picture Naming 本番", 0, 24, { inProgress: true })).toMatchObject({
      completed: 0,
      position: 1,
      total: 24,
    });
    expect(progressState("語彙学習", 24, 144, { inProgress: true })).toMatchObject({
      completed: 24,
      position: 25,
      total: 144,
    });
    expect(progressState("L2-to-L1 本番", 24, 24)).toMatchObject({
      completed: 24,
      position: 24,
      percent: 100,
      labelText: "L2-to-L1 本番　24/24 完了",
    });
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

  it("captures a raw invitation token once and removes it from the visible URL immediately", () => {
    const historyObject = { replaceState: vi.fn() };
    const location = {
      hash: "#t=raw-invitation-token&ignored=value",
      pathname: "/pre-picture-naming/",
      search: "?language=ja",
    };

    expect(consumeInvitationToken(location, historyObject)).toBe("raw-invitation-token");
    expect(historyObject.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/pre-picture-naming/?language=ja",
    );

    historyObject.replaceState.mockClear();
    expect(consumeInvitationToken({ ...location, hash: "" }, historyObject)).toBeNull();
    expect(historyObject.replaceState).not.toHaveBeenCalled();
  });

  it("retains the consumed invitation token only in the API instance", () => {
    const storage = new Map();
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        hash: "#t=memory-only-invitation-token",
        pathname: "/pre-picture-naming/",
        search: "",
      },
      history: { replaceState },
    });
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn((key) => storage.get(key) ?? null),
      setItem: vi.fn((key, value) => storage.set(key, value)),
      removeItem: vi.fn((key) => storage.delete(key)),
    });

    try {
      const api = new ExperimentApi("pre");
      expect(api.hasInvitationToken()).toBe(true);
      expect(api.invitationToken).toBe("memory-only-invitation-token");
      expect(replaceState).toHaveBeenCalledWith(null, "", "/pre-picture-naming/");
      expect([...storage.values()]).not.toContain("memory-only-invitation-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries participant access mismatches and stale name previews without treating missing Pre registration as correctable", () => {
    for (const code of [
      "participant_access_mismatch",
      "participant_name_state_changed",
    ]) {
      expect(isCorrectableParticipantAccessError(
        new ApiClientError(409, code, "retry participant confirmation"),
      )).toBe(true);
    }
    expect(isCorrectableParticipantAccessError(
      new ApiClientError(409, "participant_name_not_registered", "contact researcher"),
    )).toBe(false);
  });

  it("keeps plaintext names out of preview and confirm-redemption requests", () => {
    expect(participantNamePreviewPayload({
      invitationToken: "invite-secret",
      participantId: " 17 ",
      expectedVisitType: "immediate",
    })).toEqual({
      token: "invite-secret",
      participant_id: "17",
      expected_visit_type: "immediate",
    });

    const registration = invitationRedeemPayload({
      invitationToken: "invite-secret",
      clientInstanceId: "client-id",
      participantId: "17",
      expectedVisitType: "pre",
      nameAction: "register",
      participantName: " 山田 太郎 ",
    });
    expect(registration).toMatchObject({
      name_action: "register",
      participant_name: "山田 太郎",
      participant_name_confirmed: true,
    });

    const confirmation = invitationRedeemPayload({
      invitationToken: "invite-secret",
      clientInstanceId: "client-id",
      participantId: "17",
      expectedVisitType: "delayed",
      nameAction: "confirm",
      participantName: "must-not-be-sent",
    });
    expect(confirmation).toMatchObject({
      name_action: "confirm",
      participant_name_confirmed: true,
    });
    expect(confirmation).not.toHaveProperty("participant_name");
  });

  it("matches the server display canonicalization for full-width forms and Unicode whitespace", () => {
    expect(canonicalizeParticipantNameForDisplay(
      "　ＹＡＭＡＤＡ\u00a0\u2003ＴＡＲＯ　",
    )).toBe("YAMADA TARO");
    expect(canonicalizeParticipantNameForDisplay(
      "  ﾔﾏﾀﾞ　　太郎  ",
    )).toBe("ヤマダ 太郎");

    const payload = invitationRedeemPayload({
      invitationToken: "invite-secret",
      clientInstanceId: "client-id",
      participantId: "17",
      expectedVisitType: "pre",
      nameAction: "register",
      participantName: "　ＹＡＭＡＤＡ\u00a0\u2003ＴＡＲＯ　",
    });
    expect(payload.participant_name).toBe("YAMADA TARO");
  });

  it("validates canonical names with the server's code-point, UTF-8, control, surrogate, and bidi limits", () => {
    expect(validateParticipantNameForRegistration("a".repeat(80))).toBe("a".repeat(80));
    expect(validateParticipantNameForRegistration("😀".repeat(64))).toBe("😀".repeat(64));

    expect(() => validateParticipantNameForRegistration("a".repeat(81)))
      .toThrow("80文字以内");
    expect(() => validateParticipantNameForRegistration("😀".repeat(65)))
      .toThrow("256バイト以内");
    for (const invalidName of [
      "　　",
      "山田\u0000太郎",
      "山田\ud800太郎",
      "山田\u202e太郎",
    ]) {
      expect(() => validateParticipantNameForRegistration(invalidName))
        .toThrow(ParticipantNameValidationError);
    }
  });

  it("classifies only the server's invalid-name response as an inline-correctable name error", () => {
    expect(isCorrectableParticipantNameError(
      new ApiClientError(422, "invalid_participant_name", "invalid name"),
    )).toBe(true);
    expect(isCorrectableParticipantNameError(
      new ApiClientError(409, "participant_name_state_changed", "stale preview"),
    )).toBe(false);
  });

  it("registers a Pre name only after local review and supports editing before redemption", async () => {
    const state = stateWith({});
    const api = {
      hasInvitationToken: vi.fn().mockReturnValue(true),
      previewParticipantName: vi.fn().mockResolvedValue({ name_action: "register" }),
      bootstrap: vi.fn().mockResolvedValue(state),
    };
    const ui = {
      requestParticipantId: vi.fn().mockResolvedValue("17"),
      requestParticipantName: vi.fn()
        .mockResolvedValueOnce("　ﾔﾏﾀﾞ\u00a0\u2003太郎　")
        .mockResolvedValueOnce("　山田\u2003\u00a0花子　"),
      confirmParticipantName: vi.fn()
        .mockResolvedValueOnce("edit")
        .mockResolvedValueOnce("confirm"),
      showParticipationSetup: vi.fn(),
    };

    await expect(bootstrapWithParticipantAccess(api, ui)).resolves.toBe(state);
    expect(api.previewParticipantName).toHaveBeenCalledWith("17");
    expect(ui.requestParticipantName).toHaveBeenNthCalledWith(1, "", "");
    expect(ui.requestParticipantName).toHaveBeenNthCalledWith(2, "ヤマダ 太郎", "");
    expect(ui.confirmParticipantName).toHaveBeenNthCalledWith(
      1,
      "ヤマダ 太郎",
      { allowEdit: true },
    );
    expect(ui.confirmParticipantName).toHaveBeenNthCalledWith(
      2,
      "山田 花子",
      { allowEdit: true },
    );
    expect(api.bootstrap).toHaveBeenCalledWith({
      participant_id: "17",
      name_action: "register",
      participant_name_confirmed: true,
      participant_name: "山田 花子",
    });
    expect(ui.showParticipationSetup).toHaveBeenCalledTimes(1);
  });

  it("keeps an invalid long name on the name step and shows an inline correction message", async () => {
    const state = stateWith({});
    const tooLongName = "a".repeat(81);
    const api = {
      hasInvitationToken: vi.fn().mockReturnValue(true),
      previewParticipantName: vi.fn().mockResolvedValue({ name_action: "register" }),
      bootstrap: vi.fn().mockResolvedValue(state),
    };
    const ui = {
      requestParticipantId: vi.fn().mockResolvedValue("17"),
      requestParticipantName: vi.fn()
        .mockResolvedValueOnce(tooLongName)
        .mockResolvedValueOnce("山田 太郎"),
      confirmParticipantName: vi.fn().mockResolvedValue("confirm"),
      showParticipationSetup: vi.fn(),
    };

    await expect(bootstrapWithParticipantAccess(api, ui)).resolves.toBe(state);
    expect(ui.requestParticipantId).toHaveBeenCalledTimes(1);
    expect(api.previewParticipantName).toHaveBeenCalledTimes(1);
    expect(ui.requestParticipantName).toHaveBeenNthCalledWith(1, "", "");
    expect(ui.requestParticipantName).toHaveBeenNthCalledWith(
      2,
      tooLongName,
      expect.stringContaining("80文字以内"),
    );
    expect(ui.confirmParticipantName).toHaveBeenCalledTimes(1);
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("returns a server-rejected Pre name to inline name correction without repeating ID access", async () => {
    const state = stateWith({});
    const api = {
      hasInvitationToken: vi.fn().mockReturnValue(true),
      previewParticipantName: vi.fn().mockResolvedValue({ name_action: "register" }),
      bootstrap: vi.fn()
        .mockRejectedValueOnce(new ApiClientError(
          422,
          "invalid_participant_name",
          "server rejected participant name",
        ))
        .mockResolvedValueOnce(state),
    };
    const ui = {
      requestParticipantId: vi.fn().mockResolvedValue("17"),
      requestParticipantName: vi.fn()
        .mockResolvedValueOnce("山田 太郎")
        .mockResolvedValueOnce("山田 花子"),
      confirmParticipantName: vi.fn().mockResolvedValue("confirm"),
      showParticipationSetup: vi.fn(),
    };

    await expect(bootstrapWithParticipantAccess(api, ui)).resolves.toBe(state);
    expect(ui.requestParticipantId).toHaveBeenCalledTimes(1);
    expect(api.previewParticipantName).toHaveBeenCalledTimes(1);
    expect(ui.requestParticipantName).toHaveBeenNthCalledWith(
      2,
      "山田 太郎",
      expect.stringContaining("氏名を登録できませんでした"),
    );
    expect(ui.confirmParticipantName).toHaveBeenCalledTimes(2);
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
    expect(api.bootstrap).toHaveBeenLastCalledWith({
      participant_id: "17",
      name_action: "register",
      participant_name_confirmed: true,
      participant_name: "山田 花子",
    });
  });

  it("confirms a server-provided name without sending it back during redemption", async () => {
    const state = stateWith({});
    const api = {
      hasInvitationToken: vi.fn().mockReturnValue(true),
      previewParticipantName: vi.fn().mockResolvedValue({
        name_action: "confirm",
        participant_name: "山田 太郎",
      }),
      bootstrap: vi.fn().mockResolvedValue(state),
    };
    const ui = {
      requestParticipantId: vi.fn().mockResolvedValue("17"),
      requestParticipantName: vi.fn(),
      confirmParticipantName: vi.fn().mockResolvedValue("confirm"),
      showParticipationSetup: vi.fn(),
    };

    await expect(bootstrapWithParticipantAccess(api, ui)).resolves.toBe(state);
    expect(ui.confirmParticipantName).toHaveBeenCalledWith("山田 太郎");
    expect(ui.requestParticipantName).not.toHaveBeenCalled();
    expect(api.bootstrap).toHaveBeenCalledWith({
      participant_id: "17",
      name_action: "confirm",
      participant_name_confirmed: true,
    });
    expect(api.bootstrap.mock.calls[0][0]).not.toHaveProperty("participant_name");
  });

  it("returns to ID entry after rejecting a displayed name without redeeming that access", async () => {
    const state = stateWith({});
    const api = {
      hasInvitationToken: vi.fn().mockReturnValue(true),
      previewParticipantName: vi.fn()
        .mockResolvedValueOnce({ name_action: "confirm", participant_name: "別の 参加者" })
        .mockResolvedValueOnce({ name_action: "confirm", participant_name: "山田 太郎" }),
      bootstrap: vi.fn().mockResolvedValue(state),
    };
    const ui = {
      requestParticipantId: vi.fn()
        .mockResolvedValueOnce("16")
        .mockResolvedValueOnce("17"),
      requestParticipantName: vi.fn(),
      confirmParticipantName: vi.fn()
        .mockResolvedValueOnce("reject")
        .mockResolvedValueOnce("confirm"),
      showParticipationSetup: vi.fn(),
    };

    await expect(bootstrapWithParticipantAccess(api, ui)).resolves.toBe(state);
    expect(api.previewParticipantName).toHaveBeenNthCalledWith(1, "16");
    expect(api.previewParticipantName).toHaveBeenNthCalledWith(2, "17");
    expect(ui.requestParticipantId.mock.calls[1][0]).toContain("担当者へ連絡");
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(api.bootstrap).toHaveBeenCalledWith({
      participant_id: "17",
      name_action: "confirm",
      participant_name_confirmed: true,
    });
  });

  it("keeps tokenless stored-session bootstrap behavior unchanged", async () => {
    const state = stateWith({});
    const api = {
      hasInvitationToken: vi.fn().mockReturnValue(false),
      previewParticipantName: vi.fn(),
      bootstrap: vi.fn().mockResolvedValue(state),
    };
    const ui = {
      requestParticipantId: vi.fn(),
      requestParticipantName: vi.fn(),
      confirmParticipantName: vi.fn(),
      showParticipationSetup: vi.fn(),
    };

    await expect(bootstrapWithParticipantAccess(api, ui)).resolves.toBe(state);
    expect(api.bootstrap).toHaveBeenCalledWith();
    expect(api.previewParticipantName).not.toHaveBeenCalled();
    expect(ui.requestParticipantId).not.toHaveBeenCalled();
    expect(ui.showParticipationSetup).toHaveBeenCalledTimes(1);
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
    expect(source).toContain('aria-labelledby="participant-name-heading"');
    expect(source).toContain('aria-labelledby="participant-name-confirmation-heading"');
    expect(source).toContain('id="participant-name-confirmation-heading" tabindex="-1"');
    expect(source).toContain('id="participant-name-confirmation-value" class="summary" aria-live="polite"');
    expect(source).toContain('maxlength="256"');
    expect(source).toContain('aria-describedby="participant-name-status"');
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
      const stage = interactiveElement();
      Object.assign(ui, {
        resetStage: vi.fn(),
        message: interactiveElement(),
        promptKeyboardHint: interactiveElement(),
        continueKeyLabel,
        continueButton,
        stage,
        activePromptFinish: null,
        spaceHeld: false,
      });

      let resolved = false;
      const pending = ui.prompt("確認", "進む").then(() => { resolved = true; });
      expect(stage.getAttribute("aria-keyshortcuts")).toBe("Space");
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

  it("renders a participant name with textContent and removes it after either confirmation choice", async () => {
    const ui = Object.create(ExperimentUi.prototype);
    Object.assign(ui, {
      participantIdForm: interactiveElement(),
      participantNameForm: interactiveElement(),
      participantNameConfirmation: interactiveElement(),
      participantIdInput: interactiveElement({ value: "17" }),
      participantNameInput: interactiveElement({ value: "should-be-cleared" }),
      participantNameConfirmationHeading: interactiveElement(),
      participantNameConfirmationPrompt: interactiveElement(),
      participantNameConfirmationValue: interactiveElement(),
      participantNameConfirm: interactiveElement(),
      participantNameEdit: interactiveElement(),
      participantNameReject: interactiveElement(),
      participantNameConfirmationStatus: interactiveElement(),
    });
    const canaryName = '<img src=x onerror="throw new Error()"> 山田';

    const confirmed = ui.confirmParticipantName(canaryName);
    expect(ui.participantNameConfirmationValue.textContent).toBe(canaryName);
    expect(ui.participantNameConfirmationValue.innerHTML).toBe("unchanged-sentinel");
    expect(ui.participantNameConfirmationHeading.focus).toHaveBeenCalledTimes(1);
    ui.participantNameConfirm.dispatch("click");
    await expect(confirmed).resolves.toBe("confirm");
    expect(ui.participantNameInput.value).toBe("");
    expect(ui.participantNameConfirmationValue.textContent).toBe("");
    expect(ui.participantNameConfirmation.hidden).toBe(true);

    const rejected = ui.confirmParticipantName(canaryName);
    ui.participantNameReject.dispatch("click");
    await expect(rejected).resolves.toBe("reject");
    expect(ui.participantNameInput.value).toBe("");
    expect(ui.participantNameConfirmationValue.textContent).toBe("");
    expect(ui.participantNameConfirmation.hidden).toBe(true);

    ui.participantNameInput.value = canaryName;
    ui.participantNameConfirmationValue.textContent = canaryName;
    ui.clearParticipantAccess();
    expect(ui.participantIdInput.value).toBe("");
    expect(ui.participantNameInput.value).toBe("");
    expect(ui.participantNameConfirmationValue.textContent).toBe("");
  });

  it("shows name validation feedback inline and clears aria-invalid after resubmission", async () => {
    const ui = Object.create(ExperimentUi.prototype);
    const participantNameForm = interactiveElement({ reportValidity: vi.fn(() => true) });
    const participantNameInput = interactiveElement();
    Object.assign(ui, {
      participantIdForm: interactiveElement(),
      participantNameForm,
      participantNameConfirmation: interactiveElement(),
      participantNameInput,
      participantNameSubmit: interactiveElement(),
      participantNameStatus: interactiveElement(),
      participantNameConfirmationValue: interactiveElement(),
      participantNameConfirmationStatus: interactiveElement(),
    });

    const submitted = ui.requestParticipantName(
      "a".repeat(81),
      "氏名は80文字以内で入力してください。",
    );
    expect(ui.participantNameStatus.textContent).toContain("80文字以内");
    expect(participantNameInput.getAttribute("aria-invalid")).toBe("true");
    participantNameInput.value = "山田 太郎";
    participantNameForm.dispatch("submit");

    await expect(submitted).resolves.toBe("山田 太郎");
    expect(participantNameInput.getAttribute("aria-invalid")).toBe("false");
    expect(participantNameInput.value).toBe("");
  });

  it("passes whitespace-only names to the validator instead of ignoring submit", async () => {
    const ui = Object.create(ExperimentUi.prototype);
    const participantNameForm = interactiveElement({ reportValidity: vi.fn(() => true) });
    const participantNameInput = interactiveElement({ value: "\u3000  " });
    Object.assign(ui, {
      participantIdForm: interactiveElement(),
      participantNameForm,
      participantNameConfirmation: interactiveElement(),
      participantNameInput,
      participantNameSubmit: interactiveElement(),
      participantNameStatus: interactiveElement(),
      participantNameConfirmationValue: interactiveElement(),
      participantNameConfirmationStatus: interactiveElement(),
    });

    const submitted = ui.requestParticipantName();
    participantNameInput.value = "\u3000  ";
    participantNameForm.dispatch("submit");

    await expect(submitted).resolves.toBe("\u3000  ");
    expect(participantNameInput.value).toBe("");
  });

  it("never writes a participant name to browser storage", async () => {
    const [apiResponse, uiResponse] = await Promise.all([
      exports.default.fetch(new Request("https://experiment.test/js/api.js")),
      exports.default.fetch(new Request("https://experiment.test/js/ui.js")),
    ]);
    const apiSource = await apiResponse.text();
    const uiSource = await uiResponse.text();
    const storageWrites = apiSource
      .split("\n")
      .filter((line) => /(?:localStorage|sessionStorage)\.setItem/u.test(line))
      .join("\n");

    expect(storageWrites).not.toMatch(/participantName|participant_name/u);
    expect(uiSource).not.toMatch(/localStorage|sessionStorage/u);
    expect(uiSource).toContain("this.participantNameConfirmationValue.textContent = String(participantName ?? \"\")");
    expect(uiSource).not.toContain("participantNameConfirmationValue.innerHTML");
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
    expect(sources[0]).toContain("最初に${practiceTrials.length}回練習");
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
      progressDetail: interactiveElement(),
      saveState: { textContent: "", classList: { add: vi.fn() } },
      interruptionChoiceTitle: interactiveElement(),
      interruptionChoiceDescription: interactiveElement(),
      pauseParticipationButton: interactiveElement(),
      terminateParticipationButton: terminate,
      cancelInterruptionButton: cancel,
      interruptionChoice: interactiveElement(),
    });

    const choice = ui.confirmTerminationWithPartialData();
    expect(cancel.focus).toHaveBeenCalledTimes(1);
    expect(ui.progressDetail.textContent).toContain("保存できていません");
    expect(ui.saveState.textContent).toBe("一部未保存");
    cancel.dispatch("click");
    await expect(choice).resolves.toBe(false);
  });

  it("shows participant-facing Japanese guidance for common server errors", () => {
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
    expect(message).toContain("同じ有効な招待リンクを開き直し");
    expect(message).toContain("参加者IDを入力");
    expect(message).toContain("表示される氏名を確認");
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

  it("claims local ZIP completion only after a confirmed direct file write", () => {
    const direct = participantCopyCompletionMessage(
      PARTICIPANT_COPY_DELIVERY.DIRECT_WRITE_CONFIRMED,
    );
    expect(direct).toContain("回答と録音は保存されました");
    expect(direct).toContain("選択した保存先へのZIP書き込みも完了");
    expect(direct).not.toContain("ダウンロードを開始しました");

    const fallback = participantCopyCompletionMessage(
      PARTICIPANT_COPY_DELIVERY.DOWNLOAD_STARTED,
      { alreadyCompleted: true, filename: "accentedness_results.zip" },
    );
    expect(fallback).toContain("回答と録音も保存済み");
    expect(fallback).toContain("ZIPのダウンロードを開始しました");
    expect(fallback).toContain("Chromeのダウンロード一覧");
    expect(fallback).toContain("accentedness_results.zip");
    expect(fallback).not.toContain("ZIP書き込みも完了");
  });

  it("refuses to render participant ZIP completion for an unknown delivery state", () => {
    expect(() => participantCopyCompletionMessage("unknown"))
      .toThrow("受け渡し状態を確認できません");
  });

  it("streams a ZIP response to a selected file without creating a Blob", async () => {
    const written = [];
    const writable = {
      write: vi.fn(async (chunk) => written.push(new Uint8Array(chunk))),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const fileHandle = { createWritable: vi.fn(async () => writable) };
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const response = new Response(bytes, {
      headers: { "Content-Length": String(bytes.byteLength) },
    });

    await expect(writeResponseToFile(response, fileHandle)).resolves.toBe(bytes.byteLength);
    expect(fileHandle.createWritable).toHaveBeenCalledTimes(1);
    expect(written.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(bytes.byteLength);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
  });

  it("aborts a direct file save when the ZIP response is truncated", async () => {
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Length": "5" },
    });

    await expect(writeResponseToFile(response, {
      createWritable: vi.fn(async () => writable),
    })).rejects.toThrow("最後まで受信");
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledTimes(1);
  });

  it("labels a file-system write failure so the participant can choose another target", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Length": "3" },
    });
    const writable = {
      write: vi.fn().mockRejectedValue(new DOMException("disk full", "QuotaExceededError")),
      close: vi.fn(),
      abort: vi.fn(async () => {}),
    };

    await expect(writeResponseToFile(response, {
      createWritable: vi.fn(async () => writable),
    })).rejects.toMatchObject({ code: "participant_copy_file_write_failed" });
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
  });

  it("retries participant ZIP preparation without changing visit completion", async () => {
    const state = stateWith();
    const fetchParticipantCopy = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary copy failure"))
      .mockResolvedValue({ blob: new Blob(["zip"]), filename: "accentedness_results.zip" });
    const { runner, ui } = runnerFor(state, { fetchParticipantCopy });
    const fileHandle = { createWritable: vi.fn() };

    await expect(runner.prepareParticipantCopyWithRetry(fileHandle)).resolves.toMatchObject({
      filename: "accentedness_results.zip",
    });
    expect(fetchParticipantCopy).toHaveBeenCalledTimes(2);
    expect(fetchParticipantCopy).toHaveBeenNthCalledWith(1, fileHandle);
    expect(fetchParticipantCopy).toHaveBeenNthCalledWith(2, fileHandle);
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
