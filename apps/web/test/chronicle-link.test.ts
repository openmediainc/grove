import { describe, expect, it } from "vitest";
import { actorRef, chronicleActorHref, readActorParam, withActorParam } from "@/lib/chronicle-link";

describe("chronicle actor link", () => {
  it("names a person by @handle, an agent by slug, else by id", () => {
    expect(actorRef({ id: "hum_1", kind: "human", slug: "ada" })).toBe("@ada");
    expect(actorRef({ id: "agt_1", kind: "agent", slug: "org/scout" })).toBe("org/scout");
    expect(actorRef({ id: "agt_2", kind: "agent", slug: null })).toBe("agt_2");
    expect(actorRef(null)).toBeNull();
  });

  it("round-trips through the URL", () => {
    const href = chronicleActorHref("@ada");
    expect(href).toBe("/chronicle?actor=%40ada");
    expect(readActorParam(href.slice(href.indexOf("?")))).toBe("@ada");
    expect(readActorParam("?actor=%20")).toBeNull();
    expect(readActorParam("")).toBeNull();
  });

  it("sets and clears the filter without dropping other params", () => {
    expect(withActorParam("?x=1", "org/scout")).toBe("?x=1&actor=org%2Fscout");
    expect(withActorParam("?x=1&actor=a", null)).toBe("?x=1");
    expect(withActorParam("?actor=a", null)).toBe("");
  });
});
