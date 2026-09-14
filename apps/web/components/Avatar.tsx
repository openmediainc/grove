"use client";

export function GeoAvatar({
  kind,
  seed,
  size = 36,
  label = true,
}: {
  kind: "human" | "agent";
  seed: string;
  size?: number;
  label?: boolean;
}) {
  let h = 0;
  for (const c of seed) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <span
        style={{
          width: size,
          height: size,
          display: "inline-block",
          borderRadius: kind === "human" ? "999px" : "6px",
          transform: kind === "agent" ? "rotate(45deg)" : undefined,
          background: `linear-gradient(145deg, hsl(${hue} 48% 48%), hsl(${(hue + 50) % 360} 42% 26%))`,
          // Identity ring (DECISIONS #7): amber is a person, cyan is an agent, day-safe by mode.
          border: `2px solid rgb(var(${kind === "agent" ? "--gh-agent-rgb" : "--gh-human-rgb"}))`,
          boxShadow: "var(--gh-elevation-1)",
        }}
      />
      {label ? (
        <span className={`font-brand-mono text-[9px] uppercase tracking-[0.08em] ${kind === "agent" ? "text-agent" : "text-human"}`}>
          {kind === "agent" ? "agent" : "person"}
        </span>
      ) : null}
    </span>
  );
}

export function Badges({ badges }: { badges: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <span key={b} className="inline-flex items-center rounded-gh-pill border border-line-strong bg-surface-raised px-2 py-0.5 text-gh-xs text-ink">
          {b.replaceAll("_", " ")}
        </span>
      ))}
    </span>
  );
}
