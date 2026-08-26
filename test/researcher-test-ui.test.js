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
    participantNameForm: interactiveElement(),
    participantNameInput: interactiveElement(),
    participantNameConfirmation: interactiveElement(),
    participantNameConfirmationValue: interactiveElement(),
    participantNameConfirmationStatus: interactiveElement(),
    participationSetup: interactiveElement(),
    welcomeStatus: interactiveElement(),
  });
  return ui;
}

describe("researcher test mode UI", () => {
  it("uses the existing participant ID field without adding a separate test form or banner", async () => {
    const taskPageResponse = await exports.default.fetch(
      new Request("https://experiment.test/js/task-page.js"),
    );
    const taskPage = await taskPageResponse.text();

    expect(taskPage).toContain('id="participant-id-input"');
    expect(taskPage).toContain('pattern="test|[1-9][0-9]*"');
    expect(taskPage).not.toContain("researcher-test-banner");
    expect(taskPage).not.toContain("researcher-test-form");
    expect(taskPage).not.toContain("researcher-test-passphrase-input");
    expect(taskPage).not.toContain("researcher-test-id-input");
  });

  it("shows explicit researcher-test entry copy while preserving normal invitation copy", async () => {
    const ui = testUi();
    const testAccess = ui.requestParticipantId("", { researcherTest: true });
    expect(ui.participantIdForm.hidden).toBe(false);
    expect(ui.participantIdHeading.textContent).toBe("研究者用動作確認");
    expect(ui.participantIdGuidance.textContent).toContain("「test」と入力");
    expect(ui.participantIdGuidance.textContent).toContain("氏名の入力・確認は行いません");
    expect(ui.welcomeStatus.textContent).toContain("保存・送信されません");

    ui.participantIdInput.value = "Test";
    ui.participantIdForm.dispatch("submit");
    expect(ui.participantIdStatus.textContent).toContain("半角小文字で「test」");
    expect(ui.participantIdInput.getAttribute("aria-invalid")).toBe("true");

    ui.participantIdInput.value = "test";
    ui.participantIdForm.dispatch("submit");
    await expect(testAccess).resolves.toBe("test");
    expect(ui.participantIdStatus.textContent).toBe("研究者用テストモードを準備しています。");

    const numericUi = testUi();
    const numericAccess = numericUi.requestParticipantId();
    expect(numericUi.participantIdHeading.textContent).toBe("参加者情報の確認");
    expect(numericUi.participantIdGuidance.textContent).toBe(
      "担当者から案内された参加者IDを入力してください。次の画面で、ご自身の氏名が表示されることを確認します。",
    );
    expect(numericUi.welcomeStatus.textContent).toBe(
      "氏名は参加者記録の確認に使用します。このブラウザには保存しません。",
    );
    numericUi.participantIdInput.value = "test";
    numericUi.participantIdForm.dispatch("submit");
    expect(numericUi.participantIdInput.getAttribute("aria-invalid")).toBe("true");
    expect(numericUi.participantIdStatus.textContent).toContain("正整数");
    numericUi.participantIdInput.value = "21";
    numericUi.participantIdForm.dispatch("submit");
    await expect(numericAccess).resolves.toBe("21");
    expect(numericUi.participantIdStatus.textContent).toBe("招待リンクと参加者IDを確認しています。");
  });

  it("uses a simple badge, summary, and no-save state", () => {
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
        saveState: interactiveElement(),
        interruptionButton: interactiveElement(),
        welcomeInterruptionButton: interactiveElement(),
        progressLabel: interactiveElement(),
        progressFill: interactiveElement(),
        progressTrack: interactiveElement(),
        progressDetail: interactiveElement(),
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
      expect(ui.saveState.textContent).toBe("保存・送信なし");
      expect(ui.interruptionButtons.every((button) => button.textContent === "テストを終了"))
        .toBe(true);

      ui.setConnected(true);
      ui.setSaveState("saving");
      ui.updateProgress("単語学習", 1, 3);
      ui.clearInterruptionPending();
      expect(ui.badge.textContent).toBe("研究者用テスト");
      expect(ui.saveState.textContent).toBe("保存・送信なし");
      expect(ui.progressDetail.textContent).toContain("保存・送信されません");
      expect(ui.progressDetail.textContent).toContain("テストを終了");
      expect(ui.interruptionButtons.every((button) => button.textContent === "テストを終了"))
        .toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers a test-only exit choice and ends without participant pause or persistence copy", async () => {
    const bodyClassList = fakeClassList(["experiment-active"]);
    vi.stubGlobal("document", { body: { classList: bodyClassList } });
    try {
      const ui = Object.create(ExperimentUi.prototype);
      const exitButton = interactiveElement();
      const returnButton = interactiveElement();
      Object.assign(ui, {
        resetStage: vi.fn(),
        setInterruptionControlEnabled: vi.fn(),
        interruptionChoiceTitle: interactiveElement(),
        interruptionChoiceDescription: interactiveElement(),
        interruptionChoice: interactiveElement(),
        pauseParticipationButton: interactiveElement(),
        terminateParticipationButton: exitButton,
        cancelInterruptionButton: returnButton,
        stage: interactiveElement(),
      });

      const cancelled = ui.chooseResearcherTestExit();
      expect(ui.interruptionChoiceTitle.textContent).toBe("動作確認を終了しますか？");
      expect(ui.interruptionChoiceDescription.textContent).toBe("この画面の研究者用テストモードを終了します。");
      expect(ui.interruptionChoiceDescription.textContent).not.toMatch(/一時中断|保存|送信/u);
      expect(ui.pauseParticipationButton.hidden).toBe(true);
      expect(exitButton.textContent).toBe("テストを終了");
      expect(returnButton.textContent).toBe("テストに戻る");
      expect(returnButton.focus).toHaveBeenCalledTimes(1);
      returnButton.dispatch("click");
      await expect(cancelled).resolves.toBe(false);

      const confirmed = ui.chooseResearcherTestExit();
      exitButton.dispatch("click");
      await expect(confirmed).resolves.toBe(true);

      Object.assign(ui, {
        interruptionButtons: [exitButton],
        progressLabel: interactiveElement(),
        progressTrack: interactiveElement(),
        progressDetail: interactiveElement(),
        saveState: interactiveElement(),
        message: interactiveElement(),
      });
      ui.researcherTestInterrupted();
      expect(bodyClassList.contains("experiment-active")).toBe(false);
      expect(ui.progressLabel.textContent).toBe("動作確認終了");
      expect(ui.saveState.textContent).toBe("保存・送信なし");
      expect(exitButton.textContent).toBe("テスト終了済み");
      expect(ui.message.textContent).toBe("動作確認を終了しました。このページは閉じて構いません。");
    } finally {
      vi.unstubAllGlobals();
    }
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
        fatalMessage: interactiveElement(),
      });

      ui.fatal(new Error("trial failed"), { interruptionRequested: true });

      expect(ui.fatalMessage.textContent).toContain("研究者用動作確認");
      expect(ui.fatalMessage.textContent).toContain("保存・送信されていません");
      expect(ui.fatalMessage.textContent).toContain("「test」と入力");
      expect(ui.fatalMessage.textContent).not.toMatch(/保存範囲|氏名|招待リンク/u);
      expect(ui.fatalPanel.focus).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
