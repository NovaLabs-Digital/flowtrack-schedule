// Fetches every row from a Supabase/PostgREST query across as many pages as
// needed, rather than raising the project's global max-rows setting (which
// would make every query on every table silently truncatable, not just the
// ones that actually need every row). Use this for any query that is
// genuinely unbounded (all of a workspace's rows for a table that can grow
// past ~1000) — most queries in this app are already scoped narrowly enough
// (a single row, a date window, a series) that they never need this.
//
// `runPage(from, to)` must run the exact same filtered query every call,
// varying only the .range(from, to) — callers are responsible for a STABLE,
// deterministic .order() (append a unique tiebreaker column, typically
// `id`, after any business ordering) so pages never overlap or skip rows,
// regardless of how many rows exist or whether the table changes between
// page fetches. `.range()` bounds are inclusive on both ends (Supabase/
// PostgREST convention), matched by pageSize - 1 below.
//
// Fails closed: any page-level error aborts the whole fetch and returns
// that error immediately, discarding whatever pages already succeeded —
// never returns a partial dataset silently. Callers get back the same
// {data, error} shape a single Supabase query returns, so existing
// `if (res.error)` handling keeps working unchanged.

export interface PagedResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

const DEFAULT_PAGE_SIZE = 1000;

export async function fetchAllPages<T>(
  runPage: (from: number, to: number) => Promise<PagedResult<T>>,
  pageSize: number = DEFAULT_PAGE_SIZE
): Promise<PagedResult<T>> {
  const all: T[] = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await runPage(from, to);
    if (error) {
      return { data: null, error };
    }
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) {
      // Short (or empty) page — this was the last one.
      break;
    }
    from += pageSize;
  }

  return { data: all, error: null };
}

// Default-sized chunk for a `.in(column, ids)` filter -- bounds the QUERY
// SIZE (the filter's own id list), independent of fetchAllPages' pageSize
// above (which bounds each response's ROW count). A single .in() filter
// listing every id in a large array (e.g. every appointment across a
// workspace's entire history, once a caller stops bounding that list by a
// rolling date window) risks an oversized request regardless of how many
// rows come back -- chunking the id list itself is the fix for that, not a
// bigger page size. 300 UUIDs keeps the filter comfortably under common
// proxy/server URL-length limits while still keeping the number of chunks
// (and therefore round trips) reasonable for a busy, long-tenured
// workspace.
export const DEFAULT_ID_CHUNK_SIZE = 300;

export function chunkArray<T>(items: T[], size: number = DEFAULT_ID_CHUNK_SIZE): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Combines chunkArray (bounds the .in() filter's own id-list size) with
// fetchAllPages (bounds each chunk's own response row count) -- for a
// query filtered by a potentially large list of ids, this is the complete
// fix: neither the QUERY nor the RESPONSE can silently grow unbounded.
// `runPageForChunk(chunkIds, from, to)` must run the exact same filtered
// query for that one chunk's ids, varying only .range(from, to) -- same
// deterministic-.order() contract fetchAllPages itself requires. An empty
// `ids` array short-circuits to zero queries (matching every existing
// "if (apptIds.length > 0)" guard already in this app, rather than issuing
// a query with an empty .in() list). Fails closed on the first chunk (or
// page within a chunk) that errors, exactly like fetchAllPages -- never
// returns a partial dataset silently.
export async function fetchAllPagesChunkedIn<T>(
  ids: string[],
  runPageForChunk: (chunkIds: string[], from: number, to: number) => Promise<PagedResult<T>>,
  chunkSize: number = DEFAULT_ID_CHUNK_SIZE,
  pageSize: number = DEFAULT_PAGE_SIZE
): Promise<PagedResult<T>> {
  const all: T[] = [];
  for (const chunk of chunkArray(ids, chunkSize)) {
    const { data, error } = await fetchAllPages<T>((from, to) => runPageForChunk(chunk, from, to), pageSize);
    if (error) return { data: null, error };
    all.push(...(data ?? []));
  }
  return { data: all, error: null };
}
