/**
 * Auth Context — manages JWT token + user state across the app.
 */
import { resetPurchases } from "../services/purchases";
import React, { createContext, useContext, useEffect, useState } from "react";
import * as api from "../services/api";
import { takeRegisteredPushToken } from "../services/pushAlerts";
import { assertSession, captureSession, isCurrentSession } from "../services/session";

interface AuthState {
    user: api.User | null;
    token: string | null;
    isLoading: boolean;
    isAuthenticated: boolean;
}

interface AuthContextType extends AuthState {
    signIn: (email: string, password: string) => Promise<void>;
    signUp: (email: string, password: string, businessName?: string) => Promise<void>;
    signOut: () => Promise<void>;
    refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const SIGNED_OUT: AuthState = { user: null, token: null, isLoading: false, isAuthenticated: false };

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<AuthState>({
        user: null,
        token: null,
        isLoading: true,
        isAuthenticated: false,
    });

    // Load token on mount
    useEffect(() => {
        // Register a global 401 handler so any expired-token API call auto-signs out.
        let mounted = true;
        const session = captureSession();
        api.onUnauthorized(() => { if (mounted) setState(SIGNED_OUT); });
        const restore = async () => {
            try {
                const token = await api.getToken(session);
                if (!mounted || !isCurrentSession(session)) return;
                if (token) {
                    const user = await api.getMe(session);
                    const latestToken = await api.getToken(session);
                    if (!mounted || !isCurrentSession(session)) return;
                    if (latestToken) {
                        api.activateAccount(user.id, session);
                        setState({ user, token: latestToken, isLoading: false, isAuthenticated: true });
                    } else {
                        setState(SIGNED_OUT);
                    }
                } else {
                    setState(SIGNED_OUT);
                }
            } catch (error) {
                if (!mounted || !isCurrentSession(session)) return;
                // Only a definite rejection signs the user out. Offline or a
                // server error keeps the session so offline mode still works.
                const rejected = error instanceof api.ApiError && error.status === 401;
                const token = rejected ? null : await api.getToken(session);
                const cached = token ? await api.getCachedUser(session) : null;
                if (!mounted || !isCurrentSession(session)) return;
                if (token && cached) {
                    api.activateAccount(cached.id, session);
                    setState({ user: cached, token, isLoading: false, isAuthenticated: true });
                } else {
                    if (rejected) await api.clearToken(session);
                    if (mounted && isCurrentSession(session)) setState(SIGNED_OUT);
                }
            }
        };
        void restore().catch(() => {
            if (mounted && isCurrentSession(session)) setState(SIGNED_OUT);
        });
        return () => {
            mounted = false;
            api.onUnauthorized(null);
        };
    }, []);

    const signIn = async (email: string, password: string) => {
        const previous = captureSession();
        const closing = api.logoutSession(takeRegisteredPushToken(previous));
        const session = captureSession();
        setState(SIGNED_OUT);
        // Local invalidation happens synchronously. Old revocation is best effort
        // and cannot block this login on a stalled network request.
        void closing.catch(() => undefined);
        const { access_token, refresh_token } = await api.login(email, password);
        assertSession(session);
        try {
            await api.setSession(access_token, refresh_token, session);
            assertSession(session);
            const user = await api.getMe(session);
            assertSession(session);
            api.activateAccount(user.id, session);
            setState({ user, token: access_token, isLoading: false, isAuthenticated: true });
        } catch (error) {
            // Do not leave a partially established session in storage when the
            // follow-up profile request fails.
            if (isCurrentSession(session)) await api.clearToken(session);
            throw error;
        }
    };

    const signUp = async (email: string, password: string, businessName?: string) => {
        const session = captureSession();
        await api.register(email, password, businessName);
        assertSession(session);
        await signIn(email, password);
    };

    const signOut = async () => {
        const session = captureSession();
        setState(SIGNED_OUT);
        const closed = api.logoutSession(takeRegisteredPushToken(session));
        // Do not let a slow logout reset purchases after a new login.
        await Promise.all([closed, resetPurchases()]);
    };

    const refreshUser = async () => {
        const session = captureSession();
        try {
            const user = await api.getMe(session);
            if (isCurrentSession(session) && user.id === session.ownerId) {
                setState((s) => ({ ...s, user }));
            }
        } catch {
            // silently fail
        }
    };

    return (
        <AuthContext.Provider value={{ ...state, signIn, signUp, signOut, refreshUser }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextType {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used within AuthProvider");
    return ctx;
}
