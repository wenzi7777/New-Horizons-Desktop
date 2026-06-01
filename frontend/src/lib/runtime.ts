const rawBasePath = String(import.meta.env.BASE_URL || "/newhorizons/");

function normalizeBasePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export const APP_BASE_PATH = normalizeBasePath(rawBasePath);

export function appHref(path = "") {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  if (!APP_BASE_PATH) {
    return cleanPath ? `/${cleanPath}` : "/";
  }
  return cleanPath ? `${APP_BASE_PATH}/${cleanPath}` : `${APP_BASE_PATH}/`;
}

export function wsHref(path = "ws") {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${appHref(path)}`;
}
