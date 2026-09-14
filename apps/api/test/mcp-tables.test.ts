import { describe, expect, it } from "vitest";
import type { GroveApp } from "@grove/domain";
import { roomFrameFor } from "../src/realtime.js";
import { callTool, TOOLS } from "../src/mcp.js";

/** Minimal GroveApp stand-in: only what the table tools touch. */
function fakeGrove() {
  const agent = { id: "agt_mcp", claimState: "claimed" };
  const calls: unknown[][] = [];
  const table = { id: "tbl_1", legalMoves: ["1"], turnDeadline: null };
  const grove = {
    identity: { getAgent: async () => agent },
    tables: {
      list: async (a: unknown, input: unknown) => (calls.push(["list", a, input]), []),
      get: async (a: unknown, id: unknown) => (calls.push(["get", a, id]), table),
      join: async (a: unknown, id: unknown) => (calls.push(["join", a, id]), table),
      create: async (a: unknown, input: unknown) => (calls.push(["create", a, input]), table),
      move: async (a: unknown, id: unknown, move: unknown) => (calls.push(["move", a, id, move]), table),
    },
  } as unknown as GroveApp;
  return { grove, calls, agent };
}

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, any>;

describe("MCP table tools", () => {
  it("declares tables_list, table_join, table_move and table_state", () => {
    for (const name of ["tables_list", "table_join", "table_move", "table_state"]) expect(TOOLS.find((t) => t.name === name)).toBeTruthy();
  });

  it("delegates to the one TableService as the calling agent, in snake_case", async () => {
    const { grove, calls, agent } = fakeGrove();
    const me = { kind: "agent", agent };
    expect(payload(await callTool(grove, "agt_mcp", "tables_list", { room: "library" }))).toMatchObject({ ok: true, tables: [] });
    expect(payload(await callTool(grove, "agt_mcp", "table_state", { table_id: "tbl_1" })).table).toMatchObject({ legal_moves: ["1"] });
    await callTool(grove, "agt_mcp", "table_join", { table_id: "tbl_1" });
    await callTool(grove, "agt_mcp", "table_join", { room: "library", game: "chess", clock: "live" });
    await callTool(grove, "agt_mcp", "table_move", { table_id: "tbl_1", move: "e4" });
    expect(calls).toEqual([
      ["list", me, { room: "library" }],
      ["get", me, "tbl_1"],
      ["join", me, "tbl_1"],
      ["create", me, { room: "library", game: "chess", clock: "live" }],
      ["move", me, "tbl_1", "e4"],
    ]);
  });

  it("a table frame reaches only the bodies on its audience list", () => {
    const frame = JSON.stringify({ type: "table_update", table_id: "tbl_1", room_id: "r", status: "active", move_count: 2, delivered_to: ["hum_in"] });
    expect(roomFrameFor("hum_out", frame)).toBeNull();
    const seen = JSON.parse(roomFrameFor("hum_in", frame)!);
    expect(seen).toEqual({ type: "table_update", table_id: "tbl_1", room_id: "r", status: "active", move_count: 2 });
  });
});
