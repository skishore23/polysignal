import { NextResponse, type NextRequest } from "next/server";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const unauthorized = (): NextResponse =>
  new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": 'Basic realm="PolySignal", charset="UTF-8"'
    }
  });

const unavailable = (): NextResponse =>
  NextResponse.json(
    { error: "Mutating APIs are disabled until dashboard credentials are configured." },
    { status: 503, headers: { "cache-control": "no-store" } }
  );

export function middleware(request: NextRequest): NextResponse {
  const username = process.env.DASHBOARD_USERNAME?.trim() ?? "";
  const password = process.env.DASHBOARD_PASSWORD ?? "";
  const credentialsConfigured = username.length > 0 && password.length > 0;

  if (credentialsConfigured) {
    const expected = `Basic ${btoa(`${username}:${password}`)}`;
    if (request.headers.get("authorization") !== expected) return unauthorized();
    return NextResponse.next();
  }

  const isProductionMutation =
    process.env.NODE_ENV === "production" &&
    request.nextUrl.pathname.startsWith("/api/") &&
    !READ_METHODS.has(request.method);

  return isProductionMutation ? unavailable() : NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
