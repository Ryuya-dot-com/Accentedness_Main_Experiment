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
    expect(html).toContain("氏名は参加者がPreリンクで入力内容を確認した後に実験データベースへ保存");
    expect(html).toContain("管理画面には氏名を表示しません");
    expect(html).toContain("この表示確認は本人認証ではありません");
    expect(html).toContain("参加者IDは第二認証要素ではない");
    expect(html).toContain("誤配布・漏えいが疑われる場合");
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
    expect(script).not.toMatch(/participant_name["': ]/u);
    expect(script).not.toContain("participantName");
    expect(script).toContain("nameRegistrationFlag(payload)");
    expect(script).toContain("氏名: Pre登録済み");
    expect(script).toContain("氏名: 参加者のPre入力待ち");
    expect(script).toContain("safeSummaryValue(payload)");
    expect(script).not.toMatch(/localStorage|sessionStorage|console\./u);
  });
});
