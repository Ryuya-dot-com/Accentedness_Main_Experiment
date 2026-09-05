import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("internal admin pages", () => {
  it("serves one operator workspace without embedded secrets or raw JSON", async () => {
    const response = await exports.default.fetch(new Request("https://experiment.test/admin/"));
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain('href="/admin/admin.css"');
    expect(html).toContain('id="environment-banner"');
    expect(html).toContain('id="connection-form"');
    expect(html).toContain('id="admin-token"');
    expect(html).toContain("管理トークンはこのページを開いている間だけ保持します");
    expect(html).toContain('id="pre-invitation-form"');
    expect(html).toContain("ここでは参加者を作成しません");
    expect(html).toContain("開始済み参加者");
    expect(html).toContain("事前課題を開始した参加者が表示されます");
    expect(html).toContain('data-filter="attention"');
    expect(html).toContain('data-filter="delayed"');
    expect(html).toContain('data-filter="complete"');
    expect(html).toContain('id="participant-search-form"');
    expect(html).toContain("事前課題</th>");
    expect(html).toContain("本実験・直後課題</th>");
    expect(html).toContain("後日の課題</th>");
    expect(html).toContain("保存状態</th>");
    expect(html).toContain("次の対応</th>");
    expect(html).not.toContain('<pre id="summary"');
    expect(html).not.toContain('id="participant-name"');
    expect(html).not.toContain("test-admin-token-that-is-long-and-private");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("provides all six direct ID 999 QA pages only inside the development panel", async () => {
    const response = await exports.default.fetch(new Request("https://experiment.test/admin/"));
    const html = await response.text();

    expect(html).toContain('id="qa-panel"');
    for (const path of [
      "/pre-picture-naming/",
      "/main-experiment/",
      "/immediate-picture-naming/",
      "/immediate-l2-to-l1/",
      "/delayed-picture-naming/",
      "/delayed-l2-to-l1/",
    ]) {
      expect(html).toContain(`href="${path}"`);
    }
    expect(html).toContain("保存、再開、5日後の受付は検証しません");
  });

  it("uses read-only admin endpoints and keeps the token in memory only", async () => {
    const response = await exports.default.fetch(
      new Request("https://experiment.test/js/admin-operations.js"),
    );
    expect(response.status).toBe(200);
    const script = await response.text();

    expect(script).toContain('jsonRequest("/api/health")');
    expect(script).toContain('jsonRequest("/api/admin/participants", { token: state.token })');
    expect(script).toContain('jsonRequest("/api/admin/summary", { token: state.token })');
    expect(script).toContain("freshCopyDecision(participant, state.participants, state.health)");
    expect(script).toContain('window.addEventListener("pagehide", disconnect)');
    expect(script).toContain("participantListFromAdminPayload(participantsResult.value)");
    expect(script).toContain("if ([401, 403].includes(error?.status))");
    expect(script).not.toContain("/api/admin/delayed/due");
    expect(script).not.toContain("/api/admin/visits/");
    expect(script).not.toContain("/invitations");
    expect(script).not.toMatch(/localStorage|sessionStorage|console\./u);
    expect(script).toContain('state.token = ""');
    expect(script).toContain("participant?.next_action");
    expect(script).toContain("Content-Length");
    expect(script).toContain("現在保存済みの部分データZIPを保存");
    expect(script).toContain("全時点完了データZIPを保存");
    expect(script).not.toContain("JSON.stringify(safeSummaryValue");
  });

  it("serves the dedicated admin stylesheet", async () => {
    const response = await exports.default.fetch(
      new Request("https://experiment.test/admin/admin.css"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/css");
    const css = await response.text();
    expect(css).toContain(".environment-banner.is-blocked");
    expect(css).toContain(".participant-table");
    expect(css).toContain(".operation-status.is-error");
  });
});
