/**
 * Auth Context — manages JWT token + user state across the app.
 */
import React, { createContext, useContext, useEffect, useState } from "react";
import * as api from "../services/api";

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
        const { access_token } = await api.login(email, password);
        await api.setToken(access_token);
        const user = await api.getMe();
        setState({ user, token: access_token, isLoading: false, isAuthenticated: true });
    };

    const signUp = async (email: string, password: string, businessName?: string) => {
        await api.register(email, password, businessName);
        await signIn(email, password);
    };

    const signOut = async () => {
        await api.clearToken();
        setState({ user: null, token: null, isLoading: false, isAuthenticated: false });
    };

    return (
        <AuthContext.Provider value={{ ...state, signIn, signUp, signOut }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextType {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used within AuthProvider");
    return ctx;
}
