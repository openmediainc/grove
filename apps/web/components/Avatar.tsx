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
          border: "2px solid rgba(232,184,109,0.75)",
          boxShadow: "0 0 14px rgba(232,184,109,0.28)",
        }}
      />
      {label ? (
        <span className="text-[9px] tracking-[0.14em] font-bold" style={{ color: kind === "agent" ? "#c4b5fd" : "#e8b86d" }}>
          {kind === "agent" ? "AGENT" : "HUMAN"}
        </span>
      ) : null}
    </span>
  );
}

export function Badges({ badges }: { badges: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <span key={b} className="grove-badge">
          {b.replaceAll("_", " ")}
        </span>
      ))}
    </span>
  );
}
