import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** Default to still while the platform preference is being read. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", value => {
      changed = true;
      if (active) setReduced(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (active && !changed) setReduced(value);
    }).catch(() => { /* Keep motion disabled when the preference is unavailable. */ });
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}
