/**
 * Stdio proxy to Grove Streamable HTTP MCP. No policy engine — forwards JSON-RPC.
 * Env: AETHERIA_API_KEY, AETHERIA_MCP_URL (default http://localhost:3000/mcp)
 */
import readline from "node:readline";

const url = process.env.AETHERIA_MCP_URL ?? process.env.GROVE_MCP_URL ?? "http://localhost:3000/mcp";
const key = process.env.AETHERIA_API_KEY ?? process.env.GROVE_API_KEY ?? "";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: key ? `Bearer ${key}` : "",
      },
      body: trimmed,
    });
    const text = await res.text();
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  } catch (err) {
    const id = (() => {
      try {
        return (JSON.parse(trimmed) as { id?: unknown }).id ?? null;
      } catch {
        return null;
      }
    })();
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: (err as Error).message },
      }) + "\n",
    );
  }
});
