let activeCsrfToken = "";

export function setActiveCsrfToken(value?: string | null) {
  activeCsrfToken = value || "";
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD"].includes(method) && activeCsrfToken) {
    headers.set("X-PitchRadar-CSRF", activeCsrfToken);
  }
  const response = await fetch(input, {
    ...init,
    headers,
    credentials: "same-origin"
  });
  if (response.status === 401) window.dispatchEvent(new Event("pitchradar-auth-expired"));
  return response;
}
