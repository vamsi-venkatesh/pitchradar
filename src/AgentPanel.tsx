import {
  ArrowUp, Bot, BookMarked, Check, ChevronRight, Database, ExternalLink, Globe2, Link2,
  LoaderCircle, LockKeyhole, MessageSquareText, Plus, ShieldCheck, Sparkles, X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { authFetch } from "./auth-client";

type Selection = "shortlist" | "watch" | "skip";
interface Receipt {
  id: string;
  tool: string;
  status: "verified" | "recorded" | "proposed" | "unavailable" | "failed";
  summary: string;
  sourceUrl?: string;
  observedAt: string;
}
interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  receipts?: Receipt[];
}
interface Action {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "approved_waiting_connector" | "denied";
  createdAt: string;
}
interface AgentState {
  agent: { name: string; role: string; mode: "language_model" | "deterministic_core"; model: string };
  capabilities: {
    productRead: boolean;
    productWrite: boolean;
    directWebCheck: boolean;
    broadWebSearch: boolean;
    llmConversation: boolean;
    externalMessaging: false;
    retrieval: "live_hybrid_rag";
    automation: { provider: "n8n"; configured: boolean; deliveryEnabled: false };
    orchestration: {
      commandAgent: "command_agent";
      sharedMemory: true;
      agents: Array<{ id: string; name: string; responsibility: string }>;
      tools: string[];
    };
  };
  selections: Record<string, Selection>;
  actions: Action[];
  messages: Message[];
}
interface DurableMemory {
  id: string;
  kind: "fact" | "decision";
  text: string;
  origin?: "owner" | "web_derived" | "agent";
  createdAt: string;
  agentId: string;
}

const SESSION_STORAGE_KEY = "pitchradar.sessionId";

function readStoredSessionId() {
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY) || "owner-default";
  } catch {
    return "owner-default";
  }
}

function storeSessionId(value: string) {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, value);
  } catch {
    // Private-mode storage failures only cost persistence, never the chat.
  }
}

const quickPrompts = [
  "What should I prepare for this week?",
  "Show the availability queue",
  "Show my strongest event options",
  "What information is still missing?"
];

const toolActivityLabels: Record<string, string> = {
  retrieve_live_context: "Gathering live context…",
  query_calendar: "Checking the calendar…",
  query_opportunities: "Ranking the event options…",
  query_availability_queue: "Reading the availability queue…",
  query_research_queue: "Reading the research queue…",
  read_business_profile: "Reading the business profile…",
  search_registered_sources: "Searching registered sources…",
  search_public_web: "Searching the public web…",
  live_check_event: "Checking the official page live…",
  fetch_public_page: "Reading a public page…",
  set_opportunity_state: "Updating the internal shortlist…",
  remember_business_fact: "Saving that to memory…",
  recall_memory: "Recalling saved memory…",
  propose_external_action: "Preparing an approval request…"
};

function toolActivity(name?: string) {
  if (!name) return "Working…";
  return toolActivityLabels[name] || `Running ${name.replace(/_/g, " ")}…`;
}

type ChatResponse = AgentState & { message: Message; error?: string };

/**
 * Minimal Server-Sent-Events reader over fetch. EventSource cannot POST, so
 * the stream endpoint is consumed by splitting the response body on blank
 * lines and collecting multi-line `data:` fields per frame.
 */
async function streamChat(
  payload: { message: string; sessionId: string },
  onProgress: (event: string, data: Record<string, unknown>) => void
): Promise<ChatResponse> {
  const response = await authFetch("/api/agent/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/event-stream")) {
    // Auth or validation errors arrive as JSON; surface them without falling
    // back (a fallback request would fail identically).
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "The streaming endpoint is unavailable.");
  }
  if (!response.body) throw new Error("Streaming is not supported in this browser.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: ChatResponse | null = null;
  let streamError = "";
  const handleFrame = (frame: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event === "done") done = data as unknown as ChatResponse;
    else if (event === "error") streamError = String(data.error || "PitchRadar could not complete this request.");
    else onProgress(event, data);
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      handleFrame(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) handleFrame(buffer);
  if (streamError) throw new Error(streamError);
  if (!done) throw new Error("The stream ended without a final answer.");
  return done;
}

function Capability({ icon: Icon, label, state, on }: {
  icon: typeof Globe2;
  label: string;
  state: string;
  on: boolean;
}) {
  return (
    <div className={on ? "is-on" : "is-held"}>
      <Icon />
      <span><strong>{label}</strong><small>{state}</small></span>
      <i>{on ? <Check /> : <LockKeyhole />}</i>
    </div>
  );
}

function ReceiptRow({ receipt }: { receipt: Receipt }) {
  const label = receipt.status === "verified"
    ? "Live evidence"
    : receipt.status === "recorded"
      ? "Product updated"
      : receipt.status === "proposed"
        ? "Approval needed"
        : receipt.status === "unavailable"
          ? "Connector needed"
          : "Check failed";
  const content = (
    <>
      <span className={`receipt-state is-${receipt.status}`}><i />{label}</span>
      <strong>{receipt.summary}</strong>
      <small>{new Date(receipt.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
      {receipt.sourceUrl && <ExternalLink />}
    </>
  );
  return receipt.sourceUrl
    ? <a className="agent-receipt" href={receipt.sourceUrl} target="_blank" rel="noreferrer">{content}</a>
    : <div className="agent-receipt">{content}</div>;
}

function MemoryBadge({ origin }: { origin?: DurableMemory["origin"] }) {
  if (origin === "owner") return <span className="memory-badge is-owner">you told me</span>;
  if (origin === "web_derived") return <span className="memory-badge is-web">from the web — verify</span>;
  return <span className="memory-badge is-agent">agent note</span>;
}

export function AgentPanel({ open, onClose, onSelectionsChange }: {
  open: boolean;
  onClose: () => void;
  onSelectionsChange: (selections: Record<string, Selection>) => void;
}) {
  const [state, setState] = useState<AgentState | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState("");
  const [sessionId, setSessionId] = useState(readStoredSessionId);
  const [view, setView] = useState<"chat" | "memory">("chat");
  const [memories, setMemories] = useState<DurableMemory[] | null>(null);
  const [memoryError, setMemoryError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = state?.messages || [];

  useEffect(() => {
    if (!open) return;
    setError("");
    authFetch(`/api/agent/state?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("The PitchRadar agent service is not responding.");
        return response.json() as Promise<AgentState>;
      })
      .then((next) => {
        setState(next);
        onSelectionsChange(next.selections);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [open, sessionId, onSelectionsChange]);

  useEffect(() => {
    if (!open || view !== "memory") return;
    setMemoryError("");
    authFetch("/api/agent/memories", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("PitchRadar's memory could not be read.");
        return response.json() as Promise<{ memories: DurableMemory[] }>;
      })
      .then((body) => setMemories(body.memories))
      .catch((reason) => setMemoryError(reason instanceof Error ? reason.message : String(reason)));
  }, [open, view]);

  useEffect(() => {
    if (!open || view !== "chat") return;
    requestAnimationFrame(() => {
      const conversation = scrollRef.current;
      if (!conversation) return;
      conversation.scrollTo({
        top: messages.length || sending ? conversation.scrollHeight : 0,
        behavior: sending ? "smooth" : "auto"
      });
    });
  }, [open, view, state?.messages.length, sending]);

  function startNewConversation() {
    if (sending) return;
    const next = crypto.randomUUID();
    storeSessionId(next);
    setError("");
    setActivity("");
    setView("chat");
    setState((current) => current ? { ...current, messages: [] } : current);
    setSessionId(next); // triggers the state refetch for the fresh session
  }

  async function send(message = draft) {
    const clean = message.trim();
    if (!clean || sending) return;
    setDraft("");
    setError("");
    setActivity("");
    setView("chat");
    setSending(true);
    const optimistic: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      text: clean,
      createdAt: new Date().toISOString()
    };
    setState((current) => current ? { ...current, messages: [...current.messages, optimistic] } : current);
    try {
      let body: ChatResponse;
      try {
        body = await streamChat({ message: clean, sessionId }, (event, data) => {
          if (event === "status" && typeof data.text === "string") setActivity(data.text);
          else if (event === "tool") setActivity(toolActivity(typeof data.name === "string" ? data.name : undefined));
          else if (event === "tool_result" && typeof data.summary === "string") setActivity(data.summary);
        });
      } catch (streamReason) {
        // Streaming transport or parsing failed — retry once over the plain
        // JSON endpoint so the answer still arrives.
        console.warn("PitchRadar stream fell back to the plain chat endpoint:", streamReason);
        setActivity("");
        const response = await authFetch("/api/agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: clean, sessionId })
        });
        body = await response.json() as ChatResponse;
        if (!response.ok) throw new Error(body.error || "PitchRadar could not complete that request.");
      }
      setState(body);
      onSelectionsChange(body.selections);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
      setActivity("");
    }
  }

  async function decide(actionId: string, decision: "approve" | "deny") {
    setError("");
    try {
      const response = await authFetch(`/api/agent/actions/${actionId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not record the decision.");
      const refreshed = await authFetch(`/api/agent/state?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
        .then((item) => item.json() as Promise<AgentState>);
      setState(refreshed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function removeMemory(id: string) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId("");
    setMemoryError("");
    try {
      const response = await authFetch(`/api/agent/memories/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "The memory could not be removed.");
      }
      setMemories((current) => current ? current.filter((memory) => memory.id !== id) : current);
    } catch (reason) {
      setMemoryError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (!open) return null;

  const pending = state?.actions.filter((action) => action.status === "pending") || [];

  return (
    <>
      <button className={`agent-backdrop ${open ? "is-open" : ""}`} onClick={onClose} aria-label="Close PitchRadar agent" />
      <aside className={`agent-panel ${open ? "is-open" : ""}`} role="dialog" aria-modal="true" aria-labelledby="agent-title">
        <header className="agent-panel-head">
          <div className="agent-mark"><Sparkles /><i /></div>
          <div>
            <small>Owner workspace</small>
            <h2 id="agent-title">Ask PitchRadar</h2>
            <p>{state?.agent.role || "Event Opportunity Agent"} · {state?.agent.model || "connecting"}</p>
          </div>
          <button onClick={onClose} aria-label="Close agent"><X /></button>
        </header>

        <section className="agent-capabilities" aria-label="Agent capabilities">
          <Capability icon={Database} label="Command" state={state ? `${state.capabilities.orchestration.agents.length} agents · shared RAG` : "Routing agents"} on />
          <Capability icon={Globe2} label="Official pages" state="Live checks" on />
          <Capability icon={Link2} label="Web discovery" state={state?.capabilities.broadWebSearch ? "Connected" : "Needs search key"} on={Boolean(state?.capabilities.broadWebSearch)} />
          <Capability icon={MessageSquareText} label="Messages" state="Approval only" on={false} />
        </section>

        <nav className="agent-view-bar" aria-label="Agent workspace views">
          <div role="tablist" aria-label="Workspace view">
            <button
              role="tab"
              aria-selected={view === "chat"}
              className={view === "chat" ? "is-active" : ""}
              onClick={() => setView("chat")}
            ><MessageSquareText />Chat</button>
            <button
              role="tab"
              aria-selected={view === "memory"}
              className={view === "memory" ? "is-active" : ""}
              onClick={() => setView("memory")}
            ><BookMarked />Memory</button>
          </div>
          <button className="agent-new-chat" onClick={startNewConversation} disabled={sending}>
            <Plus />New conversation
          </button>
        </nav>

        {view === "memory" ? (
          <div className="agent-conversation agent-memory" ref={scrollRef}>
            <header className="agent-memory-head">
              <small>Durable client memory</small>
              <h3>What PitchRadar keeps</h3>
              <p>Facts and decisions saved for this client. Deleting one removes it from every future answer.</p>
            </header>
            {memoryError && <div className="agent-error"><ShieldCheck /><span><strong>Memory unchanged</strong><small>{memoryError}</small></span></div>}
            {memories === null && !memoryError && (
              <div className="agent-thinking"><LoaderCircle /><span><strong>Reading memory</strong><small>Loading the saved facts and decisions</small></span></div>
            )}
            {memories !== null && memories.length === 0 && !memoryError && (
              <p className="agent-memory-empty">Nothing saved yet. Tell me things like “remember our maximum pitch fee is €500”.</p>
            )}
            {memories?.map((memory) => (
              <article key={memory.id} className="agent-memory-item">
                <div className="agent-memory-meta">
                  <MemoryBadge origin={memory.origin} />
                  <small>{memory.kind}</small>
                  <small>{new Date(memory.createdAt).toLocaleDateString([], { day: "2-digit", month: "short" })}</small>
                  <button
                    className={`agent-memory-delete ${confirmDeleteId === memory.id ? "is-confirm" : ""}`}
                    onClick={() => removeMemory(memory.id)}
                    onBlur={() => setConfirmDeleteId((current) => current === memory.id ? "" : current)}
                    aria-label={confirmDeleteId === memory.id ? "Confirm forgetting this memory" : "Forget this memory"}
                  >{confirmDeleteId === memory.id ? "Forget?" : "×"}</button>
                </div>
                <p>{memory.text}</p>
              </article>
            ))}
          </div>
        ) : (
        <div className="agent-conversation" ref={scrollRef}>
          {!messages.length && !error && (
            <section className="agent-welcome">
              <span><Bot /></span>
              <p className="overline">Commercial copilot</p>
              <h3>Ask for a decision, not another dashboard.</h3>
              <p>Every question goes to the AI Command Agent with full access to the live product, research tools and shared client memory. External messages always stop at owner approval.</p>
              <div>
                {quickPrompts.map((prompt) => <button key={prompt} onClick={() => send(prompt)}>{prompt}<ChevronRight /></button>)}
              </div>
            </section>
          )}

          {messages.map((message) => (
            <article key={message.id} className={`agent-message is-${message.role}`}>
              <div className="agent-message-meta">
                <span>{message.role === "assistant" ? <Sparkles /> : "You"}</span>
                <small>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
              </div>
              <p>{message.text}</p>
              {message.receipts?.length ? <div className="agent-receipts">{message.receipts.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} />)}</div> : null}
            </article>
          ))}

          {sending && (
            <div className="agent-thinking">
              <LoaderCircle />
              <span>
                <strong>PitchRadar is working</strong>
                <small className={activity ? "agent-activity" : undefined}>
                  {activity || "Reading product state and checking the required tools"}
                </small>
              </span>
            </div>
          )}
          {error && <div className="agent-error"><ShieldCheck /><span><strong>Nothing was changed</strong><small>{error}</small></span></div>}

          {pending.length > 0 && (
            <section className="agent-approvals">
              <header><LockKeyhole /><div><small>Human control</small><h3>{pending.length} action{pending.length === 1 ? "" : "s"} waiting</h3></div></header>
              {pending.map((action) => (
                <article key={action.id}>
                  <strong>{action.title}</strong>
                  <p>{action.detail}</p>
                  <div>
                    <button onClick={() => decide(action.id, "deny")}>Deny</button>
                    <button onClick={() => decide(action.id, "approve")}>Approve & hold</button>
                  </div>
                </article>
              ))}
              <p>Approval records intent. No connector is enabled, so nothing can be sent yet.</p>
            </section>
          )}
        </div>
        )}

        {view === "chat" && (
        <footer className="agent-composer">
          <div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Ask about events, deadlines, organizers or next actions…"
              aria-label="Message PitchRadar"
            />
            <button onClick={() => send()} disabled={!draft.trim() || sending} aria-label="Send message"><ArrowUp /></button>
          </div>
          <p><LockKeyhole /> External actions always require approval.</p>
        </footer>
        )}
      </aside>
    </>
  );
}
