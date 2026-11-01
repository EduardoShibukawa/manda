import { expect, test } from "bun:test";

test("fixture RED determinístico", () => {
  expect("red").toBe("green");
});
