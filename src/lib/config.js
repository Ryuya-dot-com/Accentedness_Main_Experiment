export function usesPlaceholderAssets(env) {
  return String(env.ASSET_VERSION ?? "").toLowerCase().includes("placeholder")
    || String(env.ASSIGNMENT_VERSION ?? "").toLowerCase().includes("placeholder");
}

export function placeholderAssetsAllowed(env) {
  return String(env.ALLOW_PLACEHOLDER_ASSETS ?? "").toLowerCase() === "true";
}

export function testTokenPolicy(env) {
  return String(env.TEST_TOKEN_POLICY ?? "undecided").trim().toLowerCase();
}

export function collectionConfiguration(env) {
  const environment = String(env.ENVIRONMENT ?? "development").toLowerCase();
  const placeholder = usesPlaceholderAssets(env);
  const placeholderAllowed = placeholderAssetsAllowed(env);
  const tokenPolicy = testTokenPolicy(env);
  // The current manifest intentionally reuses the exact same test WAV at both timepoints.
  // A timepoint-specific-take policy requires a new key contract and assignment version.
  const tokenPolicyReady = tokenPolicy === "same_token";
  const production = environment === "production";
  return {
    environment,
    production,
    placeholder,
    placeholderAllowed,
    testTokenPolicy: tokenPolicy,
    tokenPolicyReady,
    collectionReady: !placeholder && !placeholderAllowed && tokenPolicyReady,
    blocked: production && (placeholder || placeholderAllowed || !tokenPolicyReady),
  };
}
