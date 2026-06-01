import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api, RequestError, type AuthSession } from "./api";
import { disconnectWebSocket } from "./wsClient";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  status: AuthStatus;
  user: AuthSession | null;
  loginError: string;
  login: (username: string, password: string) => Promise<AuthSession>;
  logout: () => Promise<void>;
  refresh: () => Promise<AuthSession | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function normalizeAuthenticatedSession(session: AuthSession | null | undefined) {
  if (!session?.authenticated || !session.username || !session.role) return null;
  return {
    authenticated: true,
    username: session.username,
    role: session.role,
  } satisfies AuthSession;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthSession | null>(null);
  const [loginError, setLoginError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const session = normalizeAuthenticatedSession(await api.authMe());
      if (session) {
        setUser(session);
        setStatus("authenticated");
        return session;
      }
      disconnectWebSocket();
      setUser(null);
      setStatus("unauthenticated");
      return null;
    } catch (error) {
      const statusCode = error instanceof RequestError ? error.status : 0;
      if (statusCode === 401) {
        disconnectWebSocket();
        setUser(null);
        setStatus("unauthenticated");
        return null;
      }
      disconnectWebSocket();
      setUser(null);
      setStatus("unauthenticated");
      throw error;
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    setLoginError("");
    const response = await api.login(username, password);
    const session = normalizeAuthenticatedSession(response.user);
    if (!session) {
      throw new Error("invalid_session");
    }
    setUser(session);
    setStatus("authenticated");
    return session;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      disconnectWebSocket();
      setUser(null);
      setStatus("unauthenticated");
      setLoginError("");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      loginError,
      login: async (username: string, password: string) => {
        try {
          return await login(username, password);
        } catch (error) {
          setLoginError(error instanceof Error ? error.message : "login_failed");
          throw error;
        }
      },
      logout,
      refresh,
    }),
    [login, loginError, logout, refresh, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("auth_provider_missing");
  }
  return context;
}
