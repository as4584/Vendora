/**
 * App Store submission guards for app.json: privacy manifest, permission
 * strings, and no permissions the app doesn't use.
 */
import appJson from "../app.json";

const expo = appJson.expo as any;
const pluginOptions = (name: string) => {
  const entry = expo.plugins.find((p: any) => (Array.isArray(p) ? p[0] : p) === name);
  return Array.isArray(entry) ? entry[1] : {};
};

describe("iOS privacy manifest", () => {
  const manifest = expo.ios.privacyManifests;

  it("declares no tracking", () => {
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
  });

  it("covers the required-reason APIs used by Expo SDK modules", () => {
    const types = manifest.NSPrivacyAccessedAPITypes.map((t: any) => t.NSPrivacyAccessedAPIType);
    expect(types).toEqual(expect.arrayContaining([
      "NSPrivacyAccessedAPICategoryUserDefaults",
      "NSPrivacyAccessedAPICategoryFileTimestamp",
      "NSPrivacyAccessedAPICategoryDiskSpace",
      "NSPrivacyAccessedAPICategorySystemBootTime",
    ]));
    for (const t of manifest.NSPrivacyAccessedAPITypes) expect(t.NSPrivacyAccessedAPITypeReasons.length).toBeGreaterThan(0);
  });

  it("declares collected data as linked, not tracking, for app functionality", () => {
    expect(manifest.NSPrivacyCollectedDataTypes.length).toBeGreaterThan(0);
    for (const d of manifest.NSPrivacyCollectedDataTypes) {
      expect(d.NSPrivacyCollectedDataTypeTracking).toBe(false);
      expect(d.NSPrivacyCollectedDataTypePurposes).toEqual(["NSPrivacyCollectedDataTypePurposeAppFunctionality"]);
    }
  });
});

describe("permission strings", () => {
  it("name Resqlo and say why camera and photos are needed", () => {
    const camera = pluginOptions("expo-camera");
    const picker = pluginOptions("expo-image-picker");
    expect(camera.cameraPermission).toMatch(/^Resqlo .*barcode/);
    expect(picker.cameraPermission).toBe(camera.cameraPermission);
    expect(picker.photosPermission).toMatch(/^Resqlo .*inventory/);
  });

  it("never requests microphone or Face ID (unused)", () => {
    expect(pluginOptions("expo-camera").microphonePermission).toBe(false);
    expect(pluginOptions("expo-camera").recordAudioAndroid).toBe(false);
    expect(pluginOptions("expo-image-picker").microphonePermission).toBe(false);
    expect(pluginOptions("expo-secure-store").faceIDPermission).toBe(false);
  });
});
