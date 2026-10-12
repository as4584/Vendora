Local replacements, wired in through `overrides` in package.json, so the
security-patched release of each package is used even where an Expo
dependency still expects the old API. Remove a shim once upstream (Metro,
expo-router's query-string) moves to the patched version itself.
