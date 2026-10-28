"use client";

// Shared fetch/state for the "Needs attention" feature -- used by both the
// desktop control (NeedsAttentionControl.tsx) and its mobile equivalent.
// A thin client over GET /api/dashboard/needs-attention; all eligibility
// logic lives server-side (lib/needsAttention.ts), this hook only tracks
// loading/error/data and exposes a refresh() callers can invoke after a
// likely resolution (e.g. reopening the control, or returning from
// Billing) so the count/list update without a full-page reload.
//
// Bounded/paginated: the server's 60-day lookback bounds the DATE range,
// not the row count, so the response itself is paged (see the route's own
// comment). This hook loads one page at a time and exposes loadMore() for
// a "Load more" control, while totalCount always reflects the full
// distinct-appointment count -- independent of how many pages have
// actually been loaded -- so the collapsed button's count is never wrong.
import { useCallback, useEffect, useRef, useState } from "react";

export type NeedsAttentionIssueKind = "worked_time_review" | "needs_invoicing" | "failed_message";

export type NeedsAttentionIssue = {
  kind: NeedsAttentionIssueKind;
  label: string;
};

export type NeedsAttentionEntry = {
  appointmentId: string;
  clientName: string;
  serviceType: string;
  serviceDate: string;
  scheduledFor: string;
  issues: NeedsAttentionIssue[];
};

const PAGE_SIZE = 20;

export function useNeedsAttentionData(options?: { surface?: "desktop" | "mobile" }) {
  // "mobile" tells the server to never generate needs-invoicing issues at
  // all (no mobile Billing destination exists) -- a request property, not
  // an inference from role/device, so a desktop browser resized narrow
  // still gets the full payload. See the route's own comment.
  const surface = options?.surface ?? "desktop";

  const [entries, setEntries] = useState<NeedsAttentionEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);
  // Starts true: the count must be known (for the collapsed button's own
  // "Needs attention · N" label) before the owner ever opens anything.
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildUrl = useCallback(
    (offset: number) => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      if (surface === "mobile") params.set("surface", "mobile");
      return `/api/dashboard/needs-attention?${params.toString()}`;
    },
    [surface]
  );

  type ResponseBody = {
    entries: NeedsAttentionEntry[];
    totalCount: number;
    hasMore: boolean;
    rangeStart: string;
    rangeEnd: string;
  };

  async function fetchPage(offset: number): Promise<ResponseBody> {
    const res = await fetch(buildUrl(offset));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body as ResponseBody;
  }

  // Ignores a refresh()/loadMore() response that resolves after a NEWER
  // call has already started (e.g. closing and reopening quickly) --
  // without this, a slow first response landing after a fast second one
  // would silently roll the list back to stale data.
  const requestId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    fetchPage(0)
      .then((body) => {
        if (requestId.current !== id) return;
        setEntries(body.entries ?? []);
        setTotalCount(typeof body.totalCount === "number" ? body.totalCount : (body.entries ?? []).length);
        setHasMore(!!body.hasMore);
        setRangeStart(body.rangeStart ?? null);
        setRangeEnd(body.rangeEnd ?? null);
      })
      .catch((e: Error) => {
        if (requestId.current !== id) return;
        setError(e.message || "Failed to load");
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildUrl]);

  const loadMore = useCallback(() => {
    const id = ++requestId.current;
    setLoadingMore(true);
    fetchPage(entries.length)
      .then((body) => {
        if (requestId.current !== id) return;
        setEntries((prev) => [...prev, ...(body.entries ?? [])]);
        setTotalCount(typeof body.totalCount === "number" ? body.totalCount : entries.length + (body.entries ?? []).length);
        setHasMore(!!body.hasMore);
      })
      .catch((e: Error) => {
        if (requestId.current !== id) return;
        setError(e.message || "Failed to load");
      })
      .finally(() => {
        if (requestId.current === id) setLoadingMore(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildUrl, entries.length]);

  useEffect(() => refresh(), [refresh]);

  return { entries, totalCount, hasMore, loadingMore, loadMore, rangeStart, rangeEnd, loading, error, refresh };
}
