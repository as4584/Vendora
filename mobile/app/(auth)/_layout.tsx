/**
 * Auth group layout — no tabs, simple stack for login/register.
 */
import { Stack } from "expo-router";
import { Backdrop } from "../../components/Backdrop";

export default function AuthLayout() {
    return (
        <Stack
            screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: "transparent" },
                animation: "slide_from_right",
            }}
            // Each screen carries its own photo, so sliding screens never show through.
            screenLayout={({ children }) => <Backdrop>{children}</Backdrop>}
        />
    );
}
