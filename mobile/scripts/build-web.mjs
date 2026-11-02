// Web export served by the backend at https://vendora.lexmakesit.com/ (same origin as the API).
import { execSync } from "node:child_process";
execSync("npx expo export --platform web --output-dir dist-web --clear", {
  stdio: "inherit",
  env: { ...process.env, EXPO_PUBLIC_API_BASE_URL: "/api/v1" },
});
