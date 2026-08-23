"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

const isValidWebhookUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export function AlertsSetup() {
  const [webhook, setWebhook] = React.useState("");
  const [webhookStatus, setWebhookStatus] = React.useState<string | null>(null);
  const [webhookError, setWebhookError] = React.useState<string | null>(null);
  const [testStatus, setTestStatus] = React.useState<string | null>(null);

  React.useEffect(() => {
    const loadWebhook = async () => {
      const resp = await fetch("/api/settings/webhook");
      if (resp.ok) {
        const data = await resp.json();
        setWebhook(data.url ?? "");
      }
    };
    void loadWebhook();
  }, []);

  const saveWebhook = async () => {
    setWebhookStatus(null);
    setWebhookError(null);
    const resp = await fetch("/api/settings/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: webhook })
    });
    if (resp.ok) {
      setWebhookStatus(webhook.trim() ? "Webhook saved." : "Webhook cleared.");
    } else {
      const data = (await resp.json().catch(() => null)) as { error?: string } | null;
      setWebhookError(data?.error ?? "Invalid webhook URL.");
    }
  };

  const sendTestAlert = async () => {
    setTestStatus(null);
    const resp = await fetch("/api/alerts/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tokenId: null,
        marketId: null,
        message: "Manual test alert"
      })
    });
    if (resp.ok) {
      setTestStatus("Test alert sent. Check the Action Center and your webhook.");
    } else {
      const text = await resp.text();
      setTestStatus(`Test alert failed: ${text}`);
    }
  };

  const webhookValid = webhook.trim().length === 0 || isValidWebhookUrl(webhook.trim());

  return (
    <div className="pt-6 border-t border-border/40">
      <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-primary/70 mb-3">Downstream Alerts</div>

      <div className="flex flex-col gap-3">
        <Input
          placeholder="https://example.com/webhook"
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          className="bg-black border-border focus:border-neon-green"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="accent" onClick={saveWebhook} disabled={!webhookValid} size="sm" className="flex-1">
            Save
          </Button>
          <Button variant="outline" onClick={sendTestAlert} size="sm" className="flex-1">
            Test
          </Button>
        </div>
        {!webhookValid && <div className="text-[10px] text-neon-red">Invalid URL</div>}
        {webhookStatus && <div className="text-[10px] text-neon-green">{webhookStatus}</div>}
        {webhookError && <div className="text-[10px] text-neon-red">{webhookError}</div>}
        {testStatus && <div className="text-[10px] text-muted-foreground">{testStatus}</div>}
      </div>
    </div>
  );
}
