import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("internal admin pages", () => {
  it("serves the combined invitation and result-download page without embedding secrets", async () => {
    const response = await exports.default.fetch(new Request("https://experiment.test/admin/"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("ADMIN_TOKEN");
    expect(html).not.toContain("test-admin-token-that-is-long-and-private");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  });
});
