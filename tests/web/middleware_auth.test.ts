import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "../../apps/web/node_modules/next/server.js";
import { middleware } from "../../apps/web/middleware";

afterEach(() => vi.unstubAllEnvs());

describe("production dashboard access", () => {
  it.each(["/", "/api/performance", "/api/experiment-ledger", "/api/events"])(
    "blocks unauthenticated reads of %s when credentials are absent",
    (path) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DASHBOARD_USERNAME", "");
      vi.stubEnv("DASHBOARD_PASSWORD", "");
      expect(middleware(new NextRequest(`http://localhost${path}`)).status).toBe(503);
    }
  );

  it("requires configured credentials for reads and writes", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DASHBOARD_USERNAME", "pilot");
    vi.stubEnv("DASHBOARD_PASSWORD", "secret");
    const url = "http://localhost/api/performance";
    expect(middleware(new NextRequest(url)).status).toBe(401);
    expect(
      middleware(new NextRequest(url, { headers: { authorization: "Basic " + btoa("pilot:secret") } })).status
    ).toBe(200);
  });
});
