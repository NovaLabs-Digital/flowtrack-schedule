import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const session = request.cookies.get("sft_session");
  const value = session?.value ?? "";
  const isOwner = value === "authenticated";
  const isEmployee = value.startsWith("employee:");
  const path = request.nextUrl.pathname;

  if (path.startsWith("/dashboard")) {
    if (isEmployee) {
      return NextResponse.redirect(new URL("/schedule", request.url));
    }
    if (!isOwner) {
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
