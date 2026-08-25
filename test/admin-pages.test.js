import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("internal admin pages", () => {
  it("serves the combined invitation and result-download page without embedding secrets", async () => {
    const response = await exports.default.fetch(new Request("https://experiment.test/admin/"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("ADMIN_TOKEN");
    expect(html).toContain('id="participant-name"');
    expect(html).toMatch(/id="participant-name"[^>]*required[^>]*autocomplete="off"/u);
    expect(html).toContain("招待リンクの配布先と参加者IDの組み合わせを確認");
    expect(html).toContain("実験条件の割付には使用しません");
    expect(html).toContain("平文を実験データベースへ保存しません");
    expect(html).not.toContain("test-admin-token-that-is-long-and-private");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("submits the participant name only for creation and does not retain or echo it", async () => {
    const response = await exports.default.fetch(
      new Request("https://experiment.test/js/admin-operations.js"),
    );
    expect(response.status).toBe(200);
    const script = await response.text();

    expect(script).toContain('authorizedJson("/api/admin/participants"');
    expect(script).toContain("participant_name: participantName");
    expect(script.match(/participant_name/gu)).toHaveLength(1);
    expect(script.match(/participantNameInput\.value = ""/gu)).toHaveLength(2);
    expect(script).toContain('window.addEventListener("pagehide"');
    expect(script).toContain("identityRegistrationFlag(payload)");
    expect(script).toContain("配布先確認: 登録済み");
    expect(script).toContain("participant_identity_not_registered");
    expect(script).toContain("participant_binding_mismatch");
    expect(script).toContain("safeSummaryValue(payload)");
    expect(script).not.toMatch(/localStorage|sessionStorage|console\./u);
    expect(script).not.toMatch(/textContent\s*=.*participantName/u);
  });
});
