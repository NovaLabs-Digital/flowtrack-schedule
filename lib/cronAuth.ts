import "server-only";
import { safeEqual } from "@/lib/safeEqual";

// Vercel Cron authenticates scheduled requests by sending the project's
// CRON_SECRET environment variable as `Authorization: Bearer <secret>` (see
// Vercel's cron-job documentation) -- it does not append the secret to the
// request URL. Phase 5.6C: both app/api/cron/reminders and
// app/api/cron/reconcile-subscriptions share this exact check so the two
// routes' auth behavior can never drift apart. Query-string (`?secret=`)
// authentication has been removed outright, not deprecated -- nothing in
// this repository, in production, or documented ever depended on it.
const BEARER_PREFIX = "Bearer ";

export function isAuthorizedCronRequest(authHeader: string | null, envSecret: string | undefined): boolean {
  if (!envSecret) return false;
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) return false;
  const token = authHeader.slice(BEARER_PREFIX.length);
  if (!token) return false;
  return safeEqual(token, envSecret);
}
