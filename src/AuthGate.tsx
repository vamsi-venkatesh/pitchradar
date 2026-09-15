import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useState } from "react";
import {
  Clock3,
  FileCheck2,
  LockKeyhole,
  Radar,
  Send,
  ShieldCheck
} from "lucide-react";
import { authFetch, setActiveCsrfToken } from "./auth-client";

type AuthMode = "disabled" | "required" | "misconfigured";

interface SessionResponse {
  authenticated: boolean;
  mode: AuthMode;
  csrfToken?: string | null;
  expiresAt?: string;
  error?: string;
}

interface OwnerAuthContextValue {
  mode: AuthMode;
  logout: () => Promise<void>;
}

const OwnerAuthContext = createContext<OwnerAuthContextValue>({
  mode: "disabled",
  logout: async () => undefined
});

export function useOwnerAuth() {
  return useContext(OwnerAuthContext);
}

function BrandMark() {
  return <span className="auth-brand-mark"><Radar /></span>;
}

function LockedEntry({
  state,
  onAuthenticated
}: {
  state: SessionResponse;
  onAuthenticated: (session: SessionResponse) => void;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(state.error || "");

  async function login(event: FormEvent) {
    event.preventDefault();
    if (!password || submitting || state.mode !== "required") return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password })
      });
      const body = await response.json() as SessionResponse;
      if (!response.ok) throw new Error(body.error || "Owner access could not be verified.");
      setPassword("");
      onAuthenticated(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="owner-threshold">
      <section className="owner-threshold-brief">
        <div className="auth-brand"><BrandMark /><strong>PitchRadar</strong></div>
        <p className="auth-system-state"><i /> System locked · Owner access required</p>
        <h1>Private operating room</h1>
        <p className="auth-intro">
          Event research, client records and owner approvals stay behind one private threshold.
        </p>
        <div className="auth-evidence">
          <div><span><FileCheck2 /></span><strong>Verified source receipts</strong></div>
          <div><span><ShieldCheck /></span><strong>Owner-gated outreach</strong></div>
          <div><span><Send /></span><strong>No messages sent without approval</strong></div>
        </div>
      </section>
      <section className="owner-threshold-access">
        <p className="auth-local-state"><i /> Private owner workspace</p>
        <form onSubmit={login}>
          <div className="auth-form-heading">
            <span><LockKeyhole /></span>
            <div><small>Protected workspace</small><h2>Owner access</h2></div>
          </div>
          {state.mode === "misconfigured" ? (
            <div className="auth-configuration-error">
              <strong>Owner access is not configured.</strong>
              <p>{state.error || "Set the password hash and session secret before opening this private pilot."}</p>
            </div>
          ) : (
            <>
              <label htmlFor="owner-password">Password</label>
              <input
                id="owner-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
                required
              />
              {error && <p className="auth-error" role="alert">{error}</p>}
              <button type="submit" disabled={!password || submitting}>
                {submitting ? "Checking owner access…" : "Enter PitchRadar"}
              </button>
            </>
          )}
          <p className="auth-time"><Clock3 /> Protected session · Europe/Berlin time</p>
        </form>
      </section>
    </main>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loadingError, setLoadingError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json() as SessionResponse;
        if (!response.ok && response.status !== 503) throw new Error(body.error || "Owner access is unavailable.");
        return body;
      })
      .then((body) => {
        if (!active) return;
        setActiveCsrfToken(body.csrfToken);
        setSession(body);
      })
      .catch((reason) => {
        if (!active) return;
        setLoadingError(reason instanceof Error ? reason.message : String(reason));
      });
    const expire = () => {
      setActiveCsrfToken("");
      setSession((current) => ({ authenticated: false, mode: current?.mode || "required" }));
    };
    window.addEventListener("pitchradar-auth-expired", expire);
    return () => {
      active = false;
      window.removeEventListener("pitchradar-auth-expired", expire);
    };
  }, []);

  async function logout() {
    if (session?.mode !== "required") return;
    await authFetch("/api/auth/logout", { method: "POST" });
    setActiveCsrfToken("");
    setSession({ authenticated: false, mode: "required" });
  }

  if (!session) {
    return (
      <main className="owner-threshold owner-threshold-loading" aria-live="polite">
        <BrandMark />
        <h1>{loadingError ? "Private access unavailable" : "Opening the private operating room…"}</h1>
        {loadingError && <p>{loadingError}</p>}
      </main>
    );
  }
  if (!session.authenticated) {
    return (
      <LockedEntry
        state={session}
        onAuthenticated={(next) => {
          setActiveCsrfToken(next.csrfToken);
          setSession(next);
        }}
      />
    );
  }
  return (
    <OwnerAuthContext.Provider value={{ mode: session.mode, logout }}>
      {children}
    </OwnerAuthContext.Provider>
  );
}
