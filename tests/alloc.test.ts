import { describe, expect, test } from "bun:test";
import { allocTaskIds } from "../src/alloc.ts";

describe("allocTaskIds", () => {
  test("aloca ids consecutivos depois do maior id numérico já tomado", () => {
    expect(allocTaskIds(["T13", "T150", "T9"], 2)).toEqual(["T151", "T152"]);
  });

  test("usa T1 quando nenhum id foi tomado", () => {
    expect(allocTaskIds([], 1)).toEqual(["T1"]);
  });

  test("ignora ids não numéricos", () => {
    expect(allocTaskIds(["TASK-01", "T7"], 2)).toEqual(["T8", "T9"]);
  });
});
