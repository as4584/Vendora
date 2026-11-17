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

describe("friendly errors", () => {
  const { FRIENDLY } = require("../services/errors");
  it("translates connection failures", () => {
    expect(errorMessage(new TypeError("Network request failed"), "fb")).toBe(FRIENDLY.offline);
    expect(errorMessage(new Error("Failed to fetch"), "fb")).toBe(FRIENDLY.offline);
    expect(errorMessage(new Error("Request timed out"), "fb")).toBe(FRIENDLY.offline);
  });
  it("translates server status codes", () => {
    expect(errorMessage(Object.assign(new Error("HTTP 502"), { status: 502 }), "fb")).toBe(FRIENDLY.server);
    expect(errorMessage(Object.assign(new Error("slow down"), { status: 429 }), "fb")).toBe(FRIENDLY.busy);
    expect(errorMessage(Object.assign(new Error("Unauthorized"), { status: 401 }), "fb")).toBe(FRIENDLY.session);
  });
  it("hides technical text behind the screen's own message", () => {
    expect(errorMessage(new Error("HTTP 404"), "Couldn't find that item.")).toBe("Couldn't find that item.");
    expect(errorMessage(new Error("Unexpected token < in JSON"), "fb")).toBe("fb");
  });
  it("keeps messages written for people", () => {
    expect(errorMessage(Object.assign(new Error("x"), { status: 500, detail: { message: "eBay is down for maintenance" } }), "fb")).toBe("eBay is down for maintenance");
    expect(errorMessage(Object.assign(new Error("Item is already sold"), { status: 409 }), "fb")).toBe("Item is already sold");
  });
});
