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
