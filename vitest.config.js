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
          ASSIGNMENT_VERSION: "main-v10-english-practice-placeholder",
          ASSET_VERSION: "placeholder-v2",
          ALLOW_PLACEHOLDER_ASSETS: "true",
          ALLOW_DEVELOPMENT_PARTICIPANTS: "true",
          TEST_TOKEN_POLICY: "undecided",
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
