"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  isoPoint,
  plotCaption,
  previewCamera,
  previewHeight,
  previewScene,
  previewWindow,
  viewLine,
  type DraftSpace,
  type PreviewPlot,
  type ViewAs,
  type WireClaimPreview,
} from "@/lib/claim-preview";
import { plotDistrictName } from "@/lib/districts";
import { PLOT_COLS, PLOT_ROWS, isCoreTile, regionAt } from "@/lib/map-layout";
import { LOD_SIGNBOARD, layoutSignboard } from "@/lib/signboard";
import { DEFAULT_THEME, THEME_IDS, THEME_META, preloadTheme, readThemeChoice, type ThemeId } from "@/lib/themes";
import { useTheme } from "@/lib/themes/useTheme";
import type { Theme } from "@/lib/themes/types";

const TW = 64;

/** A pressed / unpressed chip: signal edge marks the choice, never the only signal (aria-pressed). */
function toggleClass(on: boolean): string {
  return `min-h-11 rounded-gh-pill border px-3 text-xs transition-colors duration-gh-fast hover:bg-tint focus-visible:outline-none focus-visible:shadow-gh-ring sm:min-h-8 ${
    on ? "border-signal bg-tint font-medium text-ink" : "border-line-strong text-muted"
  }`;
}
const TH = 32;

/**
 * Preview before claiming (queue #48): a small, read-only map of the plot a
 * new space would get, drawn with the real theme slots (ground, building,
 * signboard) so it is the map's art, not a picture of it. No pan, no clicks,
 * no polling: it redraws only when the draft, the theme or the size changes.
 */
export function ClaimPreview({
  preview,
  draft,
  viewAs,
  onViewAs,
}: {
  preview: WireClaimPreview;
  draft: DraftSpace;
  viewAs: ViewAs;
  onViewAs: (v: ViewAs) => void;
}) {
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME);
  useEffect(() => setThemeId(readThemeChoice()), []);
  // Loaded on demand (#79): until the picked theme arrives the last one stays on the canvas.
  const theme = useTheme(themeId);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [ready, setReady] = useState<ThemeId | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void theme.art
      .prepare()
      .then(() => {
        if (!cancelled) setReady(theme.id);
      })
      .catch(() => {
        if (!cancelled) setReady(theme.id);
      });
    return () => {
      cancelled = true;
    };
  }, [theme]);

  const scene = useMemo(() => previewScene(preview, draft, viewAs, theme.lexicon), [preview, draft, viewAs, theme]);
  const district = plotDistrictName(theme.lexicon.district.names, preview.plot_index);
  const height = previewHeight(width || 360);

  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !width || ready !== theme.id) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.floor(width * dpr);
    c.height = Math.floor(height * dpr);
    drawPreview(ctx, theme, scene, preview.plot_index, district, width, height, dpr);
  }, [theme, ready, scene, preview.plot_index, district, width, height]);

  const priv = draft.preset === "private";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Preview theme">
        {THEME_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setThemeId(id)}
            onPointerEnter={() => preloadTheme(id)}
            onFocus={() => preloadTheme(id)}
            aria-pressed={id === themeId}
            className={toggleClass(id === themeId)}
          >
            {THEME_META[id].name}
          </button>
        ))}
      </div>
      {priv ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Whose view">
          <button
            type="button"
            onClick={() => onViewAs("visitors")}
            aria-pressed={viewAs === "visitors"}
            className={toggleClass(viewAs === "visitors")}
          >
            As visitors see it
          </button>
          <button
            type="button"
            onClick={() => onViewAs("owner")}
            aria-pressed={viewAs === "owner"}
            className={toggleClass(viewAs === "owner")}
          >
            As you see it
          </button>
        </div>
      ) : null}
      <div ref={wrapRef} className="w-full overflow-hidden rounded-gh-lg border border-line-strong bg-surface shadow-gh-1">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Preview of ${plotCaption(preview.plot_index, preview.ring)} in the ${theme.lexicon.name} theme`}
          style={{ width: "100%", height, display: "block" }}
        />
      </div>
      <p className="text-xs text-muted">
        {plotCaption(preview.plot_index, preview.ring)} · {viewLine(draft.preset, viewAs)}
      </p>
    </div>
  );
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + TW / 2, y + TH / 2);
  ctx.lineTo(x, y + TH);
  ctx.lineTo(x - TW / 2, y + TH / 2);
  ctx.closePath();
}

/** Outward edges of a plot, in layout space. */
function plotOutline(ctx: CanvasRenderingContext2D, p: PreviewPlot) {
  const { rect } = p;
  ctx.beginPath();
  const a = isoPoint(rect.x0, rect.y0);
  const b = isoPoint(rect.x1 + 1, rect.y0);
  const c = isoPoint(rect.x1 + 1, rect.y1 + 1);
  const d = isoPoint(rect.x0, rect.y1 + 1);
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
}

function drawPreview(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  scene: PreviewPlot[],
  plotIndex: number,
  district: string,
  w: number,
  h: number,
  dpr: number,
) {
  const { art, palette: pal } = theme;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  art.backdrop(ctx, w, h, 0);

  const cam = previewCamera(plotIndex, w, h);
  const z = cam.zoom;
  ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * cam.px, dpr * cam.py);

  // Ground: the target's block and the eight around it.
  const win = previewWindow(plotIndex);
  for (let ty = win.y0; ty <= win.y1; ty++) {
    for (let tx = win.x0; tx <= win.x1; tx++) {
      const core = isCoreTile(tx, ty);
      const { x, y } = isoPoint(tx, ty);
      ctx.save();
      diamond(ctx, x, y);
      ctx.clip();
      ctx.globalAlpha = core ? 1 : 0.55;
      art.ground(ctx, core ? regionAt(tx, ty) : "wild", x, y, tx, ty);
      ctx.restore();
      if (!core && (((tx % PLOT_COLS) + PLOT_COLS) % PLOT_COLS === 0 || ((ty % PLOT_ROWS) + PLOT_ROWS) % PLOT_ROWS === 0)) {
        diamond(ctx, x, y);
        ctx.strokeStyle = pal.plotEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // Plot tints and fences.
  for (const p of scene) {
    for (let ty = p.rect.y0; ty <= p.rect.y1; ty++) {
      for (let tx = p.rect.x0; tx <= p.rect.x1; tx++) {
        const { x, y } = isoPoint(tx, ty);
        diamond(ctx, x, y);
        ctx.fillStyle = pal.plotTint[p.access] ?? pal.plotTint.public_write;
        ctx.fill();
      }
    }
    if (p.fence) {
      ctx.save();
      plotOutline(ctx, p);
      ctx.strokeStyle = p.fence;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  // "Your plot": a dashed line in the theme's plot-name colour.
  const mine = scene.find((p) => p.mine);
  if (mine) {
    ctx.save();
    plotOutline(ctx, mine);
    ctx.setLineDash([10, 6]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = pal.plotName;
    ctx.stroke();
    ctx.restore();
  }

  // Buildings, back to front (the scene is sorted by south-most tile).
  for (const p of scene) {
    const q = isoPoint(p.rect.x0 + 2, p.rect.y0 + 1);
    ctx.save();
    ctx.globalAlpha = p.mine ? 1 : 0.9;
    art.building(ctx, p.access, q.x, q.y);
    ctx.restore();
  }

  // Signs in SCREEN space, after the world, the way the map paints them. The
  // draft's sign always shows; neighbours' only when there is room to read them.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const family = art.speechFont ?? "ui-sans-serif, system-ui, sans-serif";
  const measure = (text: string, px: number) => {
    ctx.font = `${px >= 11 ? "600 " : ""}${px}px ${family}`;
    return ctx.measureText(text).width;
  };
  const signs = scene
    .filter((p) => p.mine || z >= LOD_SIGNBOARD)
    .map((p) => {
      const f = isoPoint(p.rect.x0 + 3.5, p.rect.y0 + 2.5);
      return { p, x: f.x * z + cam.px, y: (f.y + 18) * z + cam.py };
    })
    .sort((a, b) => Number(a.p.mine) - Number(b.p.mine) || a.y - b.y);
  for (const s of signs) {
    const board = layoutSignboard(s.p.sign, { x: s.x, y: s.y }, Math.max(z, LOD_SIGNBOARD), measure);
    if (board && board.x1 > 0 && board.x0 < w && board.y1 > 0 && board.y0 < h) art.signboard(ctx, board, 0);
  }

  // The district, themed, top-left: the preview is a map surface.
  ctx.font = `600 12px ${family}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.strokeText(district, 10, 10);
  ctx.fillStyle = pal.plotName;
  ctx.fillText(district, 10, 10);
}
