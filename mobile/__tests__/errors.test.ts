import { errorMessage } from "../services/errors";

describe("errorMessage", () => {
  it("prefers server detail.message", () => {
    expect(errorMessage({ detail: { message: "Card declined" }, message: "HTTP 402" }, "fb")).toBe("Card declined");
  });
  it("uses Error.message", () => expect(errorMessage(new Error("boom"), "fb")).toBe("boom"));
  it("uses plain object message and strings", () => {
    expect(errorMessage({ message: "x" }, "fb")).toBe("x");
    expect(errorMessage("y", "fb")).toBe("y");
  });
  it("falls back for empty or unknown", () => {
    for (const e of [null, undefined, 42, {}, new Error(""), { detail: "pro_required" }]) expect(errorMessage(e, "fb")).toBe("fb");
  });
});
