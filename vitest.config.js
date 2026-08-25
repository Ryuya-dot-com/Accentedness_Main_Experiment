import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: path.join(projectDirectory, "wrangler.jsonc") },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token-that-is-long-and-private",
          RANDOMIZATION_SECRET: "test-randomization-secret-that-is-independent",
          IDENTITY_SECRET: "test-identity-secret-that-is-independent",
          TEST_MIGRATIONS: await readD1Migrations(path.join(projectDirectory, "migrations")),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.js"],
    testTimeout: 60_000,
  },
});
