from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .pressure_cal_settings import load_settings


class PressureCalNotConfigured(Exception):
    """Raised when the Pressure Calibration API URL or token is not configured."""


class PressureCalError(Exception):
    """Raised when a Pressure Calibration API call fails."""

    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


class PressureCalClient:
    """Proxy client for the Raspberry Pi Pressure Calibration API.

    All requests are authenticated with a Bearer token and use a 5-second
    timeout.  Responses are parsed as JSON and returned as plain dicts.

    Args:
        url:   Base URL of the API, e.g. ``https://pressure-cal.example.com``.
               A trailing slash is acceptable and will be normalised away.
        token: Bearer token string used in the ``Authorization`` header.
    """

    def __init__(self, url: str, token: str) -> None:
        self._base = url.rstrip("/")
        self._token = token

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build, send, and parse a JSON API request.

        Args:
            method: HTTP verb (``"GET"`` or ``"POST"``).
            path:   Path including leading slash, e.g. ``"/api/v1/health"``.
            body:   Optional request body to serialise as JSON (POST only).

        Returns:
            Parsed JSON response as a dict.

        Raises:
            PressureCalError: On HTTP errors or network/connection failures.
        """
        url = self._base + path
        data: bytes | None = None
        headers: dict[str, str] = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
        }

        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read()
                return json.loads(raw)  # type: ignore[no-any-return]
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", errors="replace")
            except Exception:
                detail = ""
            raise PressureCalError(
                f"HTTP {exc.code} from {url}: {detail}",
                status=exc.code,
            ) from exc
        except urllib.error.URLError as exc:
            raise PressureCalError(
                f"Network error contacting {url}: {exc.reason}",
                status=0,
            ) from exc
        except json.JSONDecodeError as exc:
            raise PressureCalError(
                f"Invalid JSON response from {url}: {exc}",
                status=0,
            ) from exc

    # ------------------------------------------------------------------
    # Public API methods
    # ------------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        """GET /api/v1/health — return UNO/IMADA connection status."""
        return self._request("GET", "/api/v1/health")

    def readings(self) -> dict[str, Any]:
        """GET /api/v1/readings/all — return UNO pressure + IMADA readings."""
        return self._request("GET", "/api/v1/readings/all")

    def set_target(self, kpa: float) -> dict[str, Any]:
        """POST /api/v1/pressure/target — set target pressure in kPa."""
        return self._request("POST", "/api/v1/pressure/target", {"target_kpa": kpa})

    def stop(self) -> dict[str, Any]:
        """POST /api/v1/pressure/stop — stop pressure control."""
        return self._request("POST", "/api/v1/pressure/stop")


def get_client() -> PressureCalClient:
    """Create a :class:`PressureCalClient` from the stored settings.

    Raises:
        PressureCalNotConfigured: If the URL or token has not been configured.
    """
    settings = load_settings()
    url = settings.get("url", "").strip()
    token = settings.get("token", "").strip()
    if not url or not token:
        raise PressureCalNotConfigured(
            "Pressure Calibration API URL and token are not configured. "
            "Please set them in the Settings page."
        )
    if urllib.parse.urlparse(url).scheme not in ("http", "https"):
        raise PressureCalNotConfigured("Pressure Calibration API URL must use http or https scheme.")
    return PressureCalClient(url=url, token=token)
