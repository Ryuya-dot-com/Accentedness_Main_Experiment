import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ExperimentUi } from "../public/js/ui.js";

function fakeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add: vi.fn((...names) => names.forEach((name) => values.add(name))),
    remove: vi.fn((...names) => names.forEach((name) => values.delete(name))),
    toggle: vi.fn((name, force) => {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    }),
    contains: (name) => values.has(name),
  };
}

function interactiveElement(overrides = {}) {
  const listeners = new Map();
  const attributes = new Map();
  return {
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    style: {},
    classList: fakeClassList(),
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

function testUi() {
  const ui = Object.create(ExperimentUi.prototype);
  Object.assign(ui, {
    participantIdForm: interactiveElement(),
    participantIdHeading: interactiveElement(),
    participantIdGuidance: interactiveElement(),
    participantIdInput: interactiveElement(),
    participantIdSubmit: interactiveElement(),
    participantIdStatus: interactiveElement(),
    participantIdConfirmation: interactiveElement(),
    participantIdConfirmationHeading: interactiveElement(),
    participantIdConfirmationValue: interactiveElement(),
    participantIdConfirm: interactiveElement(),
    participantIdEdit: interactiveElement(),
    researcherTokenForm: interactiveElement(),
    researcherTokenInput: interactiveElement(),
    researcherTokenSubmit: interactiveElement(),
    researcherTokenStatus: interactiveElement(),
    participationSetup: interactiveElement(),
    welcomeStatus: interactiveElement(),
  });
  return ui;
}

describe("researcher test mode UI", () => {
  it("uses exact ID 999 and a password field without adding a normal-ID or name shortcut", async () => {
    const taskPageResponse = await exports.default.fetch(
      new Request("https://experiment.test/js/task-page.js"),
    );
    const taskPage = await taskPageResponse.text();

    expect(taskPage).toContain('id="participant-id-input"');
    expect(taskPage).toContain('pattern="[1-9][0-9]*"');
    expect(taskPage).not.toContain('pattern="test|');
    expect(taskPage).not.toContain("researcher-test-banner");
    expect(taskPage).toContain('id="researcher-token-form"');
    expect(taskPage).toContain('id="researcher-token-input"');
    expect(taskPage).toContain('type="password"');
    expect(taskPage).not.toContain("researcher-test-id-input");
    expect(taskPage).not.toContain("氏名「動作確認」");
    expect(taskPage).not.toContain('id="participant-name-input"');
    expect(taskPage).toContain('id="participant-id-confirmation"');
  });

  it("shows explicit researcher-test entry copy while preserving normal common-link copy", async () => {
    const ui = testUi();
    const testAccess = ui.requestParticipantId("", { researcherTest: true });
    expect(ui.participantIdForm.hidden).toBe(false);
    expect(ui.participantIdHeading.textContent).toBe("研究者用動作確認");
    expect(ui.participantIdGuidance.textContent).toContain("「999」と入力");
    expect(ui.welcomeStatus.textContent).toContain("保存・送信されません");

    ui.participantIdInput.value = "17";
    ui.participantIdForm.dispatch("submit");
    expect(ui.participantIdStatus.textContent).toContain("半角数字で「999」");
    expect(ui.participantIdInput.getAttribute("aria-invalid")).toBe("true");

    ui.participantIdInput.value = "999";
    ui.participantIdForm.dispatch("submit");
    await expect(testAccess).resolves.toBe("999");
    expect(ui.participantIdStatus.textContent).toBe("研究者用テストモードを準備しています。");

    const numericUi = testUi();
    const numericAccess = numericUi.requestParticipantId();
    expect(numericUi.participantIdHeading.textContent).toBe("参加者IDの確認");
    expect(numericUi.participantIdGuidance.textContent).toBe(
      "担当者から案内された参加者IDを入力してください。",
    );
    expect(numericUi.welcomeStatus.textContent).toBe(
      "参加者IDは担当者から案内された番号を入力してください。",
    );
    numericUi.participantIdInput.value = "test";
    numericUi.participantIdForm.dispatch("submit");
    expect(numericUi.participantIdInput.getAttribute("aria-invalid")).toBe("true");
    expect(numericUi.participantIdStatus.textContent).toContain("半角数字だけ");
    numericUi.participantIdInput.value = "21";
    numericUi.participantIdForm.dispatch("submit");
    await expect(numericAccess).resolves.toBe("21");
    expect(numericUi.participantIdStatus.textContent).toBe("参加者IDを確認しています。");
  });

  it("confirms the displayed ID without a second text input", async () => {
    const ui = testUi();
    const confirmation = ui.confirmParticipantId("1");
    expect(ui.participantIdConfirmation.hidden).toBe(false);
    expect(ui.participantIdConfirmationValue.textContent).toBe("1");
    ui.participantIdConfirm.dispatch("click");
    await expect(confirmation).resolves.toBe("confirm");
    expect(ui.participantIdConfirmationValue.textContent).toBe("");
  });

  it("collects the admin token only in memory and clears the password field immediately", async () => {
    const ui = testUi();
    const tokenAccess = ui.requestResearcherToken();
    expect(ui.researcherTokenForm.hidden).toBe(false);
    expect(ui.researcherTokenStatus.textContent).toContain("ID 999");

    ui.researcherTokenInput.value = "test-admin-token-that-is-long-and-private";
    ui.researcherTokenForm.dispatch("submit");
    await expect(tokenAccess).resolves.toBe("test-admin-token-that-is-long-and-private");
    expect(ui.researcherTokenInput.value).toBe("");
    expect(ui.researcherTokenSubmit.disabled).toBe(true);
  });

  it("uses a simple badge and summary while hiding all exit controls", () => {
    const bodyClassList = fakeClassList();
    vi.stubGlobal("document", {
      body: {
        dataset: { visitType: "immediate" },
        classList: bodyClassList,
      },
    });
    try {
      const ui = testUi();
      Object.assign(ui, {
        researcherTestMode: false,
        badge: interactiveElement(),
        summary: interactiveElement(),
        interruptionButton: interactiveElement(),
        welcomeInterruptionButton: interactiveElement(),
        fixation: interactiveElement({ hidden: true }),
        progressFill: interactiveElement(),
        progressTrack: interactiveElement(),
      });
      ui.interruptionButtons = [ui.interruptionButton, ui.welcomeInterruptionButton];

      ui.activateResearcherTestMode({
        test_mode: true,
        test_run: {
          visit_type: "immediate",
        },
      });
      expect(ui.badge.textContent).toBe("研究者用テスト");
      expect(ui.summary.textContent).toBe("研究者用動作確認　／　直後課題");
      expect(ui.interruptionButtons.every((button) => button.hidden && button.disabled)).toBe(true);

      ui.setConnected(true);
      ui.setSaveState("saving");
      ui.updateProgress("単語学習", 1, 3, { practice: false });
      ui.clearInterruptionPending();
      expect(ui.badge.textContent).toBe("研究者用テスト");
      expect(ui.saveStateValue).toBe("not_persisted");
      expect(ui.progressTrack.getAttribute("aria-valuetext")).toBe("進み具合 33パーセント");
      expect(ui.interruptionButtons.every((button) => button.hidden && button.disabled)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not expose a researcher-test exit button or dialog flow", async () => {
    const taskPageResponse = await exports.default.fetch(
      new Request("https://experiment.test/js/task-page.js"),
    );
    const taskPage = await taskPageResponse.text();

    expect(taskPage).not.toContain("テストを終了");
    expect(ExperimentUi.prototype.chooseResearcherTestExit).toBeUndefined();
    expect(ExperimentUi.prototype.researcherTestInterrupted).toBeUndefined();
  });

  it("uses researcher-only fatal copy with a certain no-save outcome", () => {
    const bodyClassList = fakeClassList(["experiment-active"]);
    vi.stubGlobal("document", { body: { classList: bodyClassList } });
    try {
      const ui = Object.create(ExperimentUi.prototype);
      Object.assign(ui, {
        researcherTestMode: true,
        stopResponseTimer: vi.fn(),
        welcome: interactiveElement(),
        task: interactiveElement(),
        fatalPanel: interactiveElement(),
        fatalTitle: interactiveElement(),
        fatalMessage: interactiveElement(),
        fatalReload: interactiveElement({ hidden: true }),
        fatalHelp: interactiveElement(),
      });

      const interrupted = new Error("trial failed");
      interrupted.code = "trial_visibility_interrupted";
      ui.fatal(interrupted, { interruptionRequested: true });

      expect(ui.fatalMessage.textContent).toContain("研究者用動作確認");
      expect(ui.fatalMessage.textContent).toContain("試行中にこの画面が非表示");
      expect(ui.fatalMessage.textContent).toContain("保存・送信されていません");
      expect(ui.fatalMessage.textContent).toContain("参加者ID「999」");
      expect(ui.fatalMessage.textContent).toContain("管理トークン");
      expect(ui.fatalMessage.textContent).not.toMatch(/保存範囲|氏名|招待リンク/u);
      expect(ui.fatalReload.hidden).toBe(false);
      expect(ui.fatalReload.textContent).toBe("動作確認を最初からやり直す");
      expect(ui.fatalHelp.textContent).toContain("同じ問題が繰り返される場合");
      expect(ui.fatalPanel.focus).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
