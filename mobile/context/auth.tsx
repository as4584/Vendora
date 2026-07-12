/**
 * Auth Context — manages JWT token + user state across the app.
 */
import React, { createContext, useContext, useEffect, useState } from "react";
import * as api from "../services/api";
import { clearOfflineData } from "../services/offline";

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
        api.onUnauthorized(() => {
            setState({ user: null, token: null, isLoading: false, isAuthenticated: false });
        });
        (async () => {
            try {
                const token = await api.getToken();
                if (token) {
                    const user = await api.getMe();
                    setState({ user, token, isLoading: false, isAuthenticated: true });
                } else {
                    setState((s) => ({ ...s, isLoading: false }));
                }
            } catch {
                await api.clearToken();
                setState({ user: null, token: null, isLoading: false, isAuthenticated: false });
            }
        })();
    }, []);

    const signIn = async (email: string, password: string) => {
        const { access_token, refresh_token } = await api.login(email, password);
        await api.setSession(access_token, refresh_token);
        try {
            const user = await api.getMe();
            setState({ user, token: access_token, isLoading: false, isAuthenticated: true });
        } catch (error) {
            // Do not leave a partially established session in storage when the
            // follow-up profile request fails.
            await api.clearToken();
            throw error;
        }
    };

    const signUp = async (email: string, password: string, businessName?: string) => {
        await api.register(email, password, businessName);
        await signIn(email, password);
    };

    const signOut = async () => {
        await api.logoutSession();
        await clearOfflineData();
        setState({ user: null, token: null, isLoading: false, isAuthenticated: false });
    };

    const refreshUser = async () => {
        try {
            const user = await api.getMe();
            setState((s) => ({ ...s, user }));
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
