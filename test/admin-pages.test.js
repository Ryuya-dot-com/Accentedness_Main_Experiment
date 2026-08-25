import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("internal admin pages", () => {
  it("serves the combined invitation and result-download page without embedding secrets", async () => {
    const response = await exports.default.fetch(new Request("https://experiment.test/admin/"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("ADMIN_TOKEN");
    expect(html).not.toContain('id="participant-name"');
    expect(html).toContain("管理者が登録するのは参加者IDだけです");
    expect(html).toContain("氏名は参加者がPreリンクを初めて開いたときに入力");
    expect(html).toContain("平文氏名は実験データベースへ保存しません");
    expect(html).not.toContain("test-admin-token-that-is-long-and-private");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("submits only the participant ID and does not handle participant names", async () => {
    const response = await exports.default.fetch(
      new Request("https://experiment.test/js/admin-operations.js"),
    );
    expect(response.status).toBe(200);
    const script = await response.text();

    expect(script).toContain('authorizedJson("/api/admin/participants"');
    expect(script).not.toContain("participant_name");
    expect(script).not.toContain("participantName");
    expect(script).toContain("identityRegistrationFlag(payload)");
    expect(script).toContain("氏名照合: 初回登録済み");
    expect(script).toContain("氏名照合: 参加者の初回アクセス待ち");
    expect(script).toContain("safeSummaryValue(payload)");
    expect(script).not.toMatch(/localStorage|sessionStorage|console\./u);
  });
});
