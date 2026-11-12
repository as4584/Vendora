/**
 * Auth group layout — no tabs, simple stack for login/register.
 */
import { Stack } from "expo-router";
import { COLORS } from "../../theme/tokens";

export default function AuthLayout() {
    return (
        <Stack
            screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: COLORS.bg },
                animation: "slide_from_right",
            }}
        />
    );
}
