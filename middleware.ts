import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySessionCookie } from "@/lib/sessionCrypto";

export async function middleware(request: NextRequest) {
  const session = request.cookies.get("sft_session");
  const value = session?.value ?? "";
  const payload = await verifySessionCookie(value);
  const isOwner = payload?.role === "owner";
  const isTester = payload?.role === "tester";
  const isEmployee = payload?.role === "employee";
  const path = request.nextUrl.pathname;

  if (path.startsWith("/dashboard")) {
    if (isEmployee) {
      return NextResponse.redirect(new URL("/schedule", request.url));
    }
    if (!isOwner && !isTester) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  if (path === "/schedule") {
    if (isOwner) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    if (!isEmployee) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/schedule"],
};
