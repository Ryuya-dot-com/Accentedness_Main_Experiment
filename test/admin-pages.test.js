import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("internal admin pages", () => {
  it("serves the manual invitation and recording export pages without embedding secrets", async () => {
    for (const path of ["/admin/", "/admin/exports"]) {
      const response = await exports.default.fetch(new Request(`https://experiment.test${path}`));
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain("ADMIN_TOKEN");
      expect(html, path).not.toContain("test-admin-token-that-is-long-and-private");
      expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    }
  });
});
