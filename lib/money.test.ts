// Phase 5.7D-R17: pure-function tests for lib/money.ts's cents<->dollars
// conversion, parsing, and validation helpers. No I/O, no mocking needed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { centsToInputValue, formatCents, isValidPriceCents, MAX_PRICE_CENTS, parsePriceToCents } from "./money.ts";

describe("parsePriceToCents", () => {
  test("blank/whitespace-only input returns null (no price set), never 0", () => {
    assert.equal(parsePriceToCents(""), null);
    assert.equal(parsePriceToCents("   "), null);
  });

  test("'0' and '0.00' both parse to the integer 0 -- an intentional $0.00 price, distinct from blank", () => {
    assert.equal(parsePriceToCents("0"), 0);
    assert.equal(parsePriceToCents("0.00"), 0);
  });

  test("a whole-dollar amount parses correctly", () => {
    assert.equal(parsePriceToCents("45"), 4500);
  });

  test("a standard currency value with cents parses correctly", () => {
    assert.equal(parsePriceToCents("45.50"), 4550);
    assert.equal(parsePriceToCents("45.05"), 4505);
  });

  test("a single decimal digit is treated as tenths of a dollar", () => {
    assert.equal(parsePriceToCents("45.5"), 4550);
  });

  test("surrounding whitespace is trimmed", () => {
    assert.equal(parsePriceToCents("  45.50  "), 4550);
  });

  test("negative values are rejected", () => {
    assert.equal(parsePriceToCents("-5"), null);
    assert.equal(parsePriceToCents("-5.00"), null);
  });

  test("malformed values are rejected safely (never throws)", () => {
    for (const bad of ["abc", "45.", "45.555", "$45", "45,00", "NaN", "Infinity", "--5", "45-5"]) {
      assert.equal(parsePriceToCents(bad), null, `expected null for "${bad}"`);
    }
  });

  test("an excessively large value is rejected", () => {
    assert.equal(parsePriceToCents("9999999999999999999999"), null);
    assert.equal(parsePriceToCents(String((MAX_PRICE_CENTS + 1) / 100)), null);
  });

  test("the maximum allowed value itself is accepted", () => {
    assert.equal(parsePriceToCents((MAX_PRICE_CENTS / 100).toFixed(2)), MAX_PRICE_CENTS);
  });
});

describe("centsToInputValue", () => {
  test("null/undefined both produce a blank string", () => {
    assert.equal(centsToInputValue(null), "");
    assert.equal(centsToInputValue(undefined), "");
  });

  test("formats whole and fractional cents as a two-decimal string", () => {
    assert.equal(centsToInputValue(0), "0.00");
    assert.equal(centsToInputValue(4550), "45.50");
    assert.equal(centsToInputValue(4505), "45.05");
  });

  test("round-trips through parsePriceToCents", () => {
    assert.equal(parsePriceToCents(centsToInputValue(4550)!), 4550);
    assert.equal(parsePriceToCents(centsToInputValue(0)!), 0);
  });
});

describe("formatCents", () => {
  test("null/undefined render as an em dash, distinct from a real $0.00", () => {
    assert.equal(formatCents(null), "—");
    assert.equal(formatCents(undefined), "—");
  });

  test("0 renders as an explicit $0.00, never the null placeholder", () => {
    assert.equal(formatCents(0), "$0.00");
  });

  test("formats a standard amount with the dollar sign", () => {
    assert.equal(formatCents(4550), "$45.50");
  });
});

describe("isValidPriceCents", () => {
  test("accepts 0 and any positive integer up to MAX_PRICE_CENTS", () => {
    assert.equal(isValidPriceCents(0), true);
    assert.equal(isValidPriceCents(4550), true);
    assert.equal(isValidPriceCents(MAX_PRICE_CENTS), true);
  });

  test("rejects negative numbers", () => {
    assert.equal(isValidPriceCents(-1), false);
  });

  test("rejects non-integers", () => {
    assert.equal(isValidPriceCents(45.5), false);
  });

  test("rejects values above MAX_PRICE_CENTS", () => {
    assert.equal(isValidPriceCents(MAX_PRICE_CENTS + 1), false);
  });

  test("rejects non-number types safely", () => {
    for (const bad of ["45", null, undefined, NaN, Infinity, {}, [], true]) {
      assert.equal(isValidPriceCents(bad), false, `expected false for ${JSON.stringify(bad)}`);
    }
  });
});
