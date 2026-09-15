export type AutomationChannelState = "awaiting_client_configuration" | "ready" | "unavailable";

export interface N8nAutomationReadiness {
  configured: boolean;
  reachable: boolean;
  provider: "n8n";
  workflow: "pitchradar_operations_v1";
  channels: {
    googleSheets: { state: AutomationChannelState; required: string[] };
    email: { state: AutomationChannelState; required: string[] };
    whatsapp: { state: AutomationChannelState; transport: "whatsapp_gateway"; required: string[] };
  };
  externalActions: 0;
  checkedAt: string;
  error?: string;
}

const defaultChannels: N8nAutomationReadiness["channels"] = {
  googleSheets: {
    state: "awaiting_client_configuration",
    required: ["Google OAuth credential", "spreadsheet ID", "sheet name"]
  },
  email: {
    state: "awaiting_client_configuration",
    required: ["email credential", "from address", "approved recipients"]
  },
  whatsapp: {
    state: "awaiting_client_configuration",
    transport: "whatsapp_gateway",
    required: ["owner number", "explicit opt-in", "approved Meta template", "paired gateway identity"]
  }
};

export function n8nConfigured() {
  return Boolean(
    process.env.PITCHRADAR_N8N_WEBHOOK_URL &&
    process.env.PITCHRADAR_N8N_WEBHOOK_KEY
  );
}

function baseReadiness(): N8nAutomationReadiness {
  return {
    configured: n8nConfigured(),
    reachable: false,
    provider: "n8n",
    workflow: "pitchradar_operations_v1",
    channels: defaultChannels,
    externalActions: 0,
    checkedAt: new Date().toISOString()
  };
}

export async function checkN8nReadiness(): Promise<N8nAutomationReadiness> {
  const base = baseReadiness();
  if (!base.configured) return { ...base, error: "The PitchRadar n8n intake is not configured." };

  try {
    const response = await fetch(String(process.env.PITCHRADAR_N8N_WEBHOOK_URL), {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        "x-pitchradar-automation-key": String(process.env.PITCHRADAR_N8N_WEBHOOK_KEY)
      },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        eventType: "integration.check",
        occurredAt: new Date().toISOString(),
        tenantId: "demo-operator",
        projectId: "pitchradar",
        requestedChannels: ["google_sheets", "email", "whatsapp"]
      })
    });
    if (!response.ok) {
      return { ...base, error: `The n8n intake returned HTTP ${response.status}.` };
    }
    const payload = await response.json() as Partial<N8nAutomationReadiness> & { connected?: boolean };
    if (payload.connected !== true || payload.workflow !== "pitchradar_operations_v1" || payload.externalActions !== 0) {
      return { ...base, error: "The n8n intake returned an invalid safety contract." };
    }
    return {
      ...base,
      reachable: true,
      channels: payload.channels || base.channels
    };
  } catch (error) {
    return {
      ...base,
      error: `The n8n intake could not be reached: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
