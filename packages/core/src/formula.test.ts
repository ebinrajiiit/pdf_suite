import { expect, test } from "vitest";
import { dependencies, evaluate, FormulaError, numberOf, validate } from "./formula.js";

const fees = {
  "fee.tuition": "45000",
  "fee.hostel": "28,000",
  "fee.exam": "₹1,500",
  "student.name": "A Student",
  "declared.true": true,
};

test("reads the numbers people actually type into forms", () => {
  expect(numberOf("45000")).toBe(45000);
  expect(numberOf("28,000")).toBe(28000);
  expect(numberOf("₹1,500")).toBe(1500);
  expect(numberOf("")).toBe(0);
  expect(numberOf("not a number")).toBe(0);
  expect(numberOf(true)).toBe(1);
  expect(numberOf(["7"])).toBe(7);
});

test("adds up the fields a formula names", () => {
  expect(evaluate("fee.tuition + fee.hostel", fees)).toBe(73000);
  expect(evaluate("=sum(fee.tuition, fee.hostel, fee.exam)", fees)).toBe(74500);
  expect(evaluate("avg(10, 20, 30)", {})).toBe(20);
  expect(evaluate("max(fee.tuition, fee.hostel)", fees)).toBe(45000);
});

test("brackets and precedence work the way arithmetic does", () => {
  expect(evaluate("2 + 3 * 4", {})).toBe(14);
  expect(evaluate("(2 + 3) * 4", {})).toBe(20);
  expect(evaluate("-5 + 10", {})).toBe(5);
  expect(evaluate("fee.tuition * 0.1", fees)).toBeCloseTo(4500, 6);
});

test("dividing by zero gives zero, because a fee column showing infinity helps nobody", () => {
  expect(evaluate("10 / 0", {})).toBe(0);
  expect(evaluate("10 / missing.field", {})).toBe(0);
});

test("a field that is not filled in counts as zero, not as an error", () => {
  expect(evaluate("fee.tuition + fee.late", fees)).toBe(45000);
});

test("nonsense is refused with something a person can act on", () => {
  expect(() => evaluate("fee.tuition +", fees)).toThrow(FormulaError);
  expect(() => evaluate("(1 + 2", fees)).toThrow(/unclosed/);
  expect(() => evaluate("total(1, 2)", fees)).toThrow(/no function called total/);
  expect(() => evaluate("1 ^ 2", fees)).toThrow(/no meaning/);
  expect(() => evaluate("1 2", fees)).toThrow(/left over/);
});

test("the fields a formula depends on are reported, functions are not", () => {
  expect(dependencies("sum(fee.tuition, fee.hostel) * 1.18").sort()).toEqual([
    "fee.hostel",
    "fee.tuition",
  ]);
});

test("validation says what is wrong in words someone filling a form can use", () => {
  expect(validate("Name", "", { required: true })).toBe("Name has to be filled in");
  expect(validate("Name", "A Student", { required: true })).toBeUndefined();
  expect(validate("Age", "15", { min: 16 })).toBe("Age cannot be less than 16");
  expect(validate("Marks", "120", { max: 100 })).toBe("Marks cannot be more than 100");
  // An empty optional field is not a problem.
  expect(validate("Phone", "", { min: 1 })).toBeUndefined();
});
