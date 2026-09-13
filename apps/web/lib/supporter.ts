/**
 * Supporter section on /me (queue #47). Pure, so it is testable without a DOM.
 *
 * The API answers 404 while supporters are switched off (no Stripe keys), and
 * the section then renders nothing at all. Supporter status is cosmetic: it
 * never changes what anyone can do, see or build.
 */

export type SupporterWire = {
  supporter: {
    status: "active" | "canceled" | "past_due" | null;
    active: boolean;
    current_period_end: string | null;
    perks: { sign_trim: boolean; extra_decor: boolean };
  };
  price: { display: string | null };
};

export type SupportState =
  | { kind: "hidden" }
  | { kind: "offer"; price: string | null }
  | { kind: "active"; line: string }
  | { kind: "attention"; line: string };

function day(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** What the section shows. `null` (404, error, not loaded) hides it. */
export function supportState(wire: SupporterWire | null): SupportState {
  if (!wire) return { kind: "hidden" };
  const s = wire.supporter;
  if (s.status === "active") {
    const until = day(s.current_period_end);
    return { kind: "active", line: until ? `Thank you for supporting Glasshouse. Renews ${until}.` : "Thank you for supporting Glasshouse." };
  }
  if (s.status === "past_due") {
    return { kind: "attention", line: "Your last supporter payment didn't go through. Check the email from Stripe to update it." };
  }
  return { kind: "offer", price: wire.price.display };
}
