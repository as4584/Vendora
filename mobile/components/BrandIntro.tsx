/**
 * Branded launch screens.
 *
 * - `BrandLoader`: the icon on the splash colour with a soft breathing glow
 *   (a blurred copy of the icon itself, so the glow is the brand's own red).
 *   Replaces the bare spinner while the session restores, so the native
 *   splash hands off to a screen that looks identical.
 * - `BrandIntro`: shown once per install on first open. The icon settles in,
 *   the red orbit glow blooms, then the wordmark and a greeting fade up.
 *   Reduced Motion skips the animation and shows the final frame briefly.
 */
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, Platform, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useReducedMotion } from "./useReducedMotion";

/** Matches the native splash background in app.json, so the hand-off is seamless. */
export const SPLASH_BG = "#0A0A1A";
const INTRO_KEY = "resqlo.intro_seen.v1";
export const INTRO_MS = 2200;
const STILL_MS = 900;

export async function hasSeenIntro(): Promise<boolean> {
  // The intro is for the installed app; the web app opens straight to sign-in.
  if (Platform.OS === "web") return true;
  try {
    return (await AsyncStorage.getItem(INTRO_KEY)) === "1";
  } catch {
    return true; // storage unavailable: never block launch on the intro
  }
}

export async function markIntroSeen(): Promise<void> {
  try {
    await AsyncStorage.setItem(INTRO_KEY, "1");
  } catch {
    /* best effort */
  }
}

/** "Welcome, Kicks Co." when we know the business, otherwise the brand line. */
export function introGreeting(businessName?: string | null): string {
  const name = businessName?.trim();
  return name ? `Welcome back, ${name}` : "Every pair. Every sale. Every dollar.";
}

const LOGO = require("../assets/brand/resqlo-logo.png");

export function BrandLoader() {
  const reduced = useReducedMotion();
  const [pulse] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);
  const glowOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.6] });
  return (
    <View style={styles.screen} accessibilityRole="progressbar" accessibilityLabel="Loading Resqlo">
      <Animated.Image source={LOGO} blurRadius={40} style={[styles.glow, { opacity: reduced ? 0.35 : glowOpacity }]} />
      <Image source={LOGO} style={styles.logo} accessibilityIgnoresInvertColors />
    </View>
  );
}

export function BrandIntro({ businessName, onDone }: { businessName?: string | null; onDone: () => void }) {
  const reduced = useReducedMotion();
  const [logo] = useState(() => new Animated.Value(0));
  const [glow] = useState(() => new Animated.Value(0));
  const [words] = useState(() => new Animated.Value(0));
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    void markIntroSeen();
    if (reduced) {
      logo.setValue(1);
      glow.setValue(1);
      words.setValue(1);
      const t = setTimeout(() => doneRef.current(), STILL_MS);
      return () => clearTimeout(t);
    }
    const run = Animated.sequence([
      Animated.parallel([
        Animated.spring(logo, { toValue: 1, friction: 7, tension: 40, useNativeDriver: true }),
        Animated.timing(glow, { toValue: 1, duration: 900, delay: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.timing(words, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]);
    run.start();
    const t = setTimeout(() => doneRef.current(), INTRO_MS);
    return () => {
      run.stop();
      clearTimeout(t);
    };
  }, [glow, logo, reduced, words]);

  const scale = logo.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] });
  const glowScale = glow.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.15] });
  const glowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] });
  const rise = words.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });

  return (
    <View style={styles.screen} accessible accessibilityLabel={`Resqlo. ${introGreeting(businessName)}`}>
      <Animated.Image source={LOGO} blurRadius={40} style={[styles.glow, { opacity: glowOpacity, transform: [{ scale: glowScale }] }]} />
      <Animated.Image
        source={LOGO}
        style={[styles.logo, { opacity: logo, transform: [{ scale }] }]}
        accessibilityIgnoresInvertColors
      />
      <Animated.View style={[styles.words, { opacity: words, transform: [{ translateY: rise }] }]}>
        <Text style={styles.wordmark} maxFontSizeMultiplier={1.2}>RESQLO</Text>
        <Text style={styles.tagline} maxFontSizeMultiplier={1.3}>{introGreeting(businessName)}</Text>
      </Animated.View>
    </View>
  );
}

const LOGO_SIZE = 132;
const styles = StyleSheet.create({
  screen: { ...StyleSheet.absoluteFill, backgroundColor: SPLASH_BG, alignItems: "center", justifyContent: "center", zIndex: 100 },
  logo: { width: LOGO_SIZE, height: LOGO_SIZE, borderRadius: LOGO_SIZE * 0.24 },
  glow: {
    position: "absolute",
    width: LOGO_SIZE * 2.1,
    height: LOGO_SIZE * 2.1,
    borderRadius: LOGO_SIZE * 1.05,
  },
  words: { position: "absolute", bottom: "26%", alignItems: "center", paddingHorizontal: 24 },
  wordmark: { color: "#FFFFFF", fontSize: 26, fontWeight: "800", letterSpacing: 8 },
  tagline: { color: "rgba(255,255,255,0.72)", fontSize: 15, marginTop: 10, textAlign: "center" },
});
