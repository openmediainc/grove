import { api } from "./api";
import { gp } from "./base";
import { LOGOUT_PATH } from "./viewer";

/** Ends the session server-side (cookie + session key), then back to the map. */
export async function signOut(): Promise<void> {
  try {
    await api(LOGOUT_PATH, { method: "POST", body: "{}" });
  } catch {
    /* already gone: the map is still the right place to land */
  }
  window.location.href = gp("/");
}
