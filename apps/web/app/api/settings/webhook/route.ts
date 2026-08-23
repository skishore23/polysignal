import { getDb } from "../../../../lib/db";
import { eq, settings } from "@polysignal/storage";


export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const { db } = getDb();
  const row = db.select().from(settings).where(eq(settings.key, "webhook_url")).all()[0];
  const credentialsConfigured =
    Boolean(process.env.DASHBOARD_USERNAME?.trim()) && Boolean(process.env.DASHBOARD_PASSWORD);
  const mayExposeValue = process.env.NODE_ENV !== "production" || credentialsConfigured;
  return Response.json({
    url: mayExposeValue ? row?.value ?? "" : "",
    configured: Boolean(row?.value)
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { url?: string };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (url && !isValidWebhookUrl(url)) {
    return Response.json({ error: "Webhook URL must be http(s)." }, { status: 400 });
  }
  const { db } = getDb();
  db.insert(settings)
    .values({ key: "webhook_url", value: url })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: url }
    })
    .run();
  return new Response("ok", { status: 200 });
}

function isValidWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
