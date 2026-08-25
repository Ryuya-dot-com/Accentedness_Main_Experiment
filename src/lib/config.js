export function usesPlaceholderAssets(env) {
  return String(env.ASSET_VERSION ?? "").toLowerCase().includes("placeholder")
    || String(env.ASSIGNMENT_VERSION ?? "").toLowerCase().includes("placeholder");
}

export function placeholderAssetsAllowed(env) {
  return String(env.ALLOW_PLACEHOLDER_ASSETS ?? "").toLowerCase() === "true";
}

export function collectionConfiguration(env) {
  const environment = String(env.ENVIRONMENT ?? "development").toLowerCase();
  const placeholder = usesPlaceholderAssets(env);
  const placeholderAllowed = placeholderAssetsAllowed(env);
  const production = environment === "production";
  return {
    environment,
    production,
    placeholder,
    placeholderAllowed,
    collectionReady: !placeholder && !placeholderAllowed,
    blocked: production && (placeholder || placeholderAllowed),
  };
}
