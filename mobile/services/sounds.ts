/**
 * Short UI sounds: a soft blip per scan, a register chime per completed sale.
 * Respect the phone's silent switch and mix with whatever music is playing,
 * so a seller's playlist at a show never gets cut off.
 *
 * Sounds are synthesized in-house (assets/sounds/*.wav), so no licensing.
 * Everything fails quietly: a sound must never break a sale.
 */
type SoundName = "scan" | "sale";

const SOURCES: Record<SoundName, number> = {
  scan: require("../assets/sounds/scan.wav"),
  sale: require("../assets/sounds/sale.wav"),
};

type Player = { seekTo: (s: number) => unknown; play: () => void };
const players: Partial<Record<SoundName, Player>> = {};
let modeSet = false;

function audio() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("expo-audio") as typeof import("expo-audio");
}

function player(name: SoundName): Player | null {
  try {
    const mod = audio();
    if (!modeSet) {
      modeSet = true;
      void mod.setAudioModeAsync({ playsInSilentMode: false, interruptionMode: "mixWithOthers" }).catch(() => undefined);
    }
    players[name] ??= mod.createAudioPlayer(SOURCES[name]);
    return players[name] ?? null;
  } catch {
    return null;
  }
}

export function playSound(name: SoundName): void {
  try {
    const p = player(name);
    if (!p) return;
    void p.seekTo(0);
    p.play();
  } catch {
    // Audio unavailable (web, simulator quirks): stay silent.
  }
}
