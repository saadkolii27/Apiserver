import { Resend } from "resend";

let connectionSettings: Record<string, { settings: { api_key: string; from_email?: string } }> | null = null;

async function getCredentials(): Promise<{ apiKey: string; fromEmail: string }> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;

  if (!hostname || !xReplitToken) {
    throw new Error("Resend connector not available in this environment");
  }

  const data = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=resend`,
    {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken,
      },
    }
  ).then((r) => r.json());

  const item = (data as { items?: Array<{ settings: { api_key: string; from_email?: string } }> }).items?.[0];
  if (!item?.settings?.api_key) {
    throw new Error("Resend not connected — api_key missing");
  }

  return {
    apiKey: item.settings.api_key,
    fromEmail: item.settings.from_email ?? "WebMonitor <noreply@webmonitor.app>",
  };
}

export async function getUncachableResendClient(): Promise<{
  client: Resend;
  fromEmail: string;
}> {
  const { apiKey, fromEmail } = await getCredentials();
  return { client: new Resend(apiKey), fromEmail };
}
