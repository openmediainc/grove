import { describe, expect, it } from "vitest";
import { KEYBOARD_GAP_PX, KEYBOARD_MIN_PX, keyboardInset, revealBy, takesTyping } from "@/lib/keyboard";

describe("keyboardInset", () => {
  it("is the part of the screen under the keyboard", () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336);
  });
  it("subtracts a visual viewport that has been panned down", () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 100 })).toBe(236);
  });
  it("ignores small differences (URL bar showing and hiding)", () => {
    expect(keyboardInset(844, { height: 844 - (KEYBOARD_MIN_PX - 1), offsetTop: 0 })).toBe(0);
    expect(keyboardInset(844, { height: 900, offsetTop: 0 })).toBe(0);
  });
  it("is zero without a visual viewport or with nonsense", () => {
    expect(keyboardInset(844, null)).toBe(0);
    expect(keyboardInset(Number.NaN, { height: 300, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(844, { height: Number.NaN, offsetTop: 0 })).toBe(0);
  });
  it("never reports more than the screen", () => {
    expect(keyboardInset(844, { height: -500, offsetTop: 0 })).toBe(844);
  });
});

describe("takesTyping", () => {
  it("is true for text fields", () => {
    expect(takesTyping({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(takesTyping({ tagName: "input", type: "email" })).toBe(true);
    expect(takesTyping({ tagName: "INPUT" })).toBe(true);
    expect(takesTyping({ tagName: "TEXTAREA" })).toBe(true);
    expect(takesTyping({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("is false for controls that bring up no keyboard", () => {
    expect(takesTyping({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(takesTyping({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(takesTyping({ tagName: "BUTTON" })).toBe(false);
    expect(takesTyping(null)).toBe(false);
  });
});

describe("revealBy", () => {
  it("scrolls a field under the keys up to just above them", () => {
    expect(revealBy(520, { height: 444, offsetTop: 0 })).toBe(520 - 444 + KEYBOARD_GAP_PX);
  });
  it("is zero for a field already above the keys", () => {
    expect(revealBy(400, { height: 444, offsetTop: 0 })).toBe(0);
  });
  it("counts a panned visual viewport", () => {
    expect(revealBy(520, { height: 444, offsetTop: 100 })).toBe(0);
  });
});
