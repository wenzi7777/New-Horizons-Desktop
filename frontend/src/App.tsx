import { Suspense, lazy } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import packageJson from "../package.json";

import { DeviceFilesPage } from "./pages/DeviceFilesPage";
import { DeviceSettingsPage } from "./pages/DeviceSettingsPage";
import { DeviceWikiPage } from "./pages/DeviceWikiPage";
import { FilesPage } from "./pages/FilesPage";
import { GatewaysPage } from "./pages/GatewaysPage";
import { LaunchpadPage } from "./pages/LaunchpadPage";
import { LoginPage } from "./pages/LoginPage";
import { AppStorePage } from "./pages/AppStorePage";
import { DeviceAppsPage } from "./pages/DeviceAppsPage";
import { PluginsPage } from "./pages/PluginsPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { TerminalPage } from "./pages/TerminalPage";
import { VisualizationPage } from "./pages/VisualizationPage";
import { useI18n, type Locale } from "./i18n";
import { useAuth } from "./lib/auth";

// App Studio carries a code editor; loaded on first visit so it stays out of
// the bundle everyone else downloads. (Its files keep the "Sdk" name: the
// compiler and simulator it runs are the App Library's SDK.)
const SdkPage = lazy(() => import("./pages/SdkPage"));

type Role = "admin" | "user";
const APP_VERSION = `v${packageJson.version}`;

const NAV_ITEMS = [
  { to: "/", labelKey: "home", roles: ["admin"] as Role[] },
  { to: "/visualization", labelKey: "navVisualize", roles: ["admin", "user"] as Role[] },
  { to: "/gateways", labelKey: "navGateways", roles: ["admin"] as Role[] },
  { to: "/profiles", labelKey: "navProfile", roles: ["admin", "user"] as Role[] },
  { to: "/wiki", labelKey: "navWiki", roles: ["admin", "user"] as Role[] },
  { to: "/csv", labelKey: "csvExport", roles: ["admin"] as Role[] },
  { to: "/apps", labelKey: "navApps", roles: ["admin"] as Role[] },
  { to: "/studio", labelKey: "navSdk", roles: ["admin"] as Role[] },
  { to: "/plugins", labelKey: "navPlugins", roles: ["admin"] as Role[] },
];

function allowedRoles(roles: readonly string[], currentRole: string | undefined) {
  return Boolean(currentRole && roles.includes(currentRole));
}

function RequireRole({ roles, children }: { roles: Role[]; children: JSX.Element }) {
  const { user } = useAuth();
  const role = user?.role as Role | undefined;
  if (!allowedRoles(roles, role)) {
    return <Navigate to={role === "user" ? "/visualization" : "/login"} replace />;
  }
  return children;
}

function LoadingScreen() {
  return (
    <main className="login-shell">
      <section className="login-panel login-panel-compact">
        <p className="login-loading">Loading session…</p>
      </section>
    </main>
  );
}

function AuthenticatedApp() {
  const { locale, setLocale, t } = useI18n();
  const { user, logout } = useAuth();
  const role = (user?.role ?? "user") as Role;
  const navItems = NAV_ITEMS.filter((item) => allowedRoles(item.roles, role));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <h1>{t("appTitle")}</h1>
          <small className="app-version">{APP_VERSION}</small>
        </div>
        <nav className="topnav" aria-label={t("appTitle")}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
              to={item.to}
              end={item.to === "/"}
            >
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-session">
          <label className="language-select">
            <span className="sr-only">{t("language")}</span>
            <select
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
              aria-label={t("language")}
            >
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <div className="session-chip">
            <span>{user?.username}</span>
            <small>{role}</small>
          </div>
          <button className="button ghost compact" type="button" onClick={() => void logout()}>
            {t("logout")}
          </button>
        </div>
      </header>
      <main className="page-shell">
        <Routes>
          <Route path="/login" element={<Navigate to={role === "user" ? "/visualization" : "/"} replace />} />
          <Route
            path="/"
            element={
              role === "admin" ? <LaunchpadPage /> : <Navigate to="/visualization" replace />
            }
          />
          <Route
            path="/device/:deviceUid/settings"
            element={
              <RequireRole roles={["admin"]}>
                <DeviceSettingsPage />
              </RequireRole>
            }
          />
          <Route
            path="/device/:deviceUid/files"
            element={
              <RequireRole roles={["admin"]}>
                <DeviceFilesPage />
              </RequireRole>
            }
          />
          <Route
            path="/device/:deviceUid/wiki"
            element={
              <RequireRole roles={["admin", "user"]}>
                <DeviceWikiPage />
              </RequireRole>
            }
          />
          <Route
            path="/device/:deviceUid/commands"
            element={
              <RequireRole roles={["admin"]}>
                <TerminalPage />
              </RequireRole>
            }
          />
          <Route
            path="/terminal"
            element={
              <RequireRole roles={["admin"]}>
                <TerminalPage />
              </RequireRole>
            }
          />
          <Route
            path="/wiki"
            element={
              <RequireRole roles={["admin", "user"]}>
                <DeviceWikiPage />
              </RequireRole>
            }
          />
          <Route
            path="/profiles"
            element={
              <RequireRole roles={["admin", "user"]}>
                <ProfilesPage />
              </RequireRole>
            }
          />
          <Route
            path="/files"
            element={
              <RequireRole roles={["admin"]}>
                <FilesPage />
              </RequireRole>
            }
          />
          <Route
            path="/csv"
            element={
              <RequireRole roles={["admin"]}>
                <FilesPage />
              </RequireRole>
            }
          />
          <Route
            path="/visualization"
            element={
              <RequireRole roles={["admin", "user"]}>
                <VisualizationPage />
              </RequireRole>
            }
          />
          <Route
            path="/gateways"
            element={
              <RequireRole roles={["admin"]}>
                <GatewaysPage />
              </RequireRole>
            }
          />
          <Route
            path="/plugins"
            element={
              <RequireRole roles={["admin"]}>
                <PluginsPage />
              </RequireRole>
            }
          />
          <Route
            path="/plugins/:pluginId"
            element={
              <RequireRole roles={["admin"]}>
                <PluginsPage />
              </RequireRole>
            }
          />
          <Route
            path="/apps"
            element={
              <RequireRole roles={["admin"]}>
                <AppStorePage />
              </RequireRole>
            }
          />
          <Route
            path="/device/:deviceUid/apps"
            element={
              <RequireRole roles={["admin"]}>
                <DeviceAppsPage />
              </RequireRole>
            }
          />
          <Route
            path="/apps/:appId"
            element={
              <RequireRole roles={["admin"]}>
                <AppStorePage />
              </RequireRole>
            }
          />
          {/* v0.10.0 shipped this page at /sdk. */}
          <Route path="/sdk" element={<Navigate to="/studio" replace />} />
          <Route
            path="/studio"
            element={
              <RequireRole roles={["admin"]}>
                <Suspense fallback={<p className="sdk-hint">{t("loading")}</p>}>
                  <SdkPage />
                </Suspense>
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to={role === "user" ? "/visualization" : "/"} replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const { status } = useAuth();

  if (status === "loading") {
    return <LoadingScreen />;
  }
  if (status === "unauthenticated") {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return <AuthenticatedApp />;
}
