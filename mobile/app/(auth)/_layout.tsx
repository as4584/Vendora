/**
 * Auth group layout — no tabs, simple stack for login/register.
 */
import { Stack } from "expo-router";

export default function AuthLayout() {
    return (
        <Stack
            screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: "#0A0A1A" },
                animation: "slide_from_right",
            }}
        />
    );
}
