// Secrets et variables non listées dans wrangler.jsonc (déclarations fusionnées avec worker-configuration.d.ts).
interface Env {
  RODIUM_API_KEY?: string;
  RODIUM_BASE_URL?: string;
  RODIUM_MODEL?: string;
  AGENT_MODE?: string;
  MANAGER_PHONE?: string;
  GREENAPI_ID_INSTANCE?: string;
  GREENAPI_TOKEN?: string;
  GREENAPI_BASE_URL?: string;
  WEBHOOK_SECRET?: string;
  DEMO_TOKEN?: string;
  TZ?: string;
}
