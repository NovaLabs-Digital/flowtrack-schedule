// Direct unit tests for lib/paginate.ts's fetchAllPages/chunkArray/
// fetchAllPagesChunkedIn. No real Supabase client is needed -- runPage/
// runPageForChunk are plain in-memory functions here, which is sufficient
// to prove the pagination/chunking CONTRACT (page boundaries, chunk
// boundaries, error propagation, empty-input short-circuit) independent of
// any specific table or route.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchAllPages, chunkArray, fetchAllPagesChunkedIn, type PagedResult } from "./paginate.ts";

describe("fetchAllPages", () => {
  test("a single short page (fewer rows than pageSize) makes exactly one call", async () => {
    let calls = 0;
    const res = await fetchAllPages<number>(async (from, to) => {
      calls += 1;
      assert.deepEqual([from, to], [0, 4]);
      return { data: [1, 2, 3], error: null };
    }, 5);
    assert.equal(calls, 1);
    assert.deepEqual(res.data, [1, 2, 3]);
    assert.equal(res.error, null);
  });

  test("a full first page (exactly pageSize rows) triggers a second call; a short second page ends the loop", async () => {
    const calls: Array<[number, number]> = [];
    const res = await fetchAllPages<number>(async (from, to) => {
      calls.push([from, to]);
      if (from === 0) return { data: [1, 2], error: null }; // exactly pageSize=2 -> not done
      return { data: [3], error: null }; // short -> done
    }, 2);
    assert.deepEqual(calls, [[0, 1], [2, 3]]);
    assert.deepEqual(res.data, [1, 2, 3]);
  });

  test("an empty first page ends the loop immediately with an empty result, not an error", async () => {
    const res = await fetchAllPages<number>(async () => ({ data: [], error: null }), 10);
    assert.deepEqual(res.data, []);
    assert.equal(res.error, null);
  });

  test("fails closed: a page-level error aborts immediately and discards whatever pages already succeeded", async () => {
    let calls = 0;
    const res = await fetchAllPages<number>(async (from) => {
      calls += 1;
      if (from === 0) return { data: [1, 2], error: null }; // full page, would continue
      return { data: null, error: { message: "boom" } };
    }, 2);
    assert.equal(calls, 2);
    assert.equal(res.data, null);
    assert.deepEqual(res.error, { message: "boom" });
  });
});

describe("chunkArray", () => {
  test("splits into fixed-size chunks, with a final short chunk", () => {
    assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  test("a list shorter than the chunk size produces exactly one chunk", () => {
    assert.deepEqual(chunkArray([1, 2], 10), [[1, 2]]);
  });

  test("an empty list produces zero chunks, not one empty chunk", () => {
    assert.deepEqual(chunkArray([], 10), []);
  });

  test("the default chunk size is used when none is given", () => {
    const ids = Array.from({ length: 301 }, (_, i) => `id-${i}`);
    const chunks = chunkArray(ids);
    assert.equal(chunks.length, 2, "301 ids at the 300 default chunk size -> 2 chunks");
    assert.equal(chunks[0].length, 300);
    assert.equal(chunks[1].length, 1);
  });
});

describe("fetchAllPagesChunkedIn", () => {
  test("an empty id list makes zero calls and returns an empty result", async () => {
    let calls = 0;
    const res = await fetchAllPagesChunkedIn<number>([], async () => {
      calls += 1;
      return { data: [], error: null };
    });
    assert.equal(calls, 0);
    assert.deepEqual(res.data, []);
  });

  test("ids are split into chunks, and each chunk receives its OWN id sub-list, not the full list", async () => {
    const seenChunks: string[][] = [];
    const ids = ["a", "b", "c", "d", "e"];
    const res = await fetchAllPagesChunkedIn<string>(
      ids,
      async (chunkIds) => {
        seenChunks.push(chunkIds);
        return { data: chunkIds, error: null };
      },
      2 // chunkSize
    );
    assert.deepEqual(seenChunks, [["a", "b"], ["c", "d"], ["e"]]);
    assert.deepEqual(res.data, ["a", "b", "c", "d", "e"], "results from every chunk are concatenated, in chunk order");
  });

  test("a single chunk whose own response exceeds pageSize is itself paginated via fetchAllPages, not truncated", async () => {
    const ids = ["a", "b"]; // one chunk (chunkSize=300 default is >= 2)
    const pageCallsForChunk: Array<[number, number]> = [];
    const res = await fetchAllPagesChunkedIn<number>(
      ids,
      async (_chunkIds, from, to) => {
        pageCallsForChunk.push([from, to]);
        if (from === 0) return { data: Array.from({ length: 5 }, (_, i) => i), error: null }; // full page (pageSize=5)
        return { data: [99], error: null }; // short -> done
      },
      300,
      5 // pageSize
    );
    assert.deepEqual(pageCallsForChunk, [[0, 4], [5, 9]]);
    assert.equal(res.data!.length, 6, "all 5 rows from the full page plus 1 from the short page");
  });

  test("fails closed: an error on a LATER chunk discards results already accumulated from earlier chunks", async () => {
    const ids = ["a", "b", "c", "d"];
    let chunkIndex = 0;
    const res = await fetchAllPagesChunkedIn<string>(
      ids,
      async (chunkIds) => {
        chunkIndex += 1;
        if (chunkIndex === 2) return { data: null, error: { message: "chunk 2 failed" } };
        return { data: chunkIds, error: null };
      },
      1 // chunkSize=1 -> 4 chunks, one per id
    );
    assert.equal(res.data, null, "the whole call fails closed, even though chunk 1 already succeeded");
    assert.deepEqual(res.error, { message: "chunk 2 failed" });
  });
});
