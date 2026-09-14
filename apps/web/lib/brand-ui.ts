/**
 * Brand chrome recipes (DECISIONS #7, docs/design/DESIGN.md). Class strings
 * built only from semantic tokens, so a component looks right in light, night
 * and tv without knowing which is on. Rollout rows #73–#75 adopt these; the
 * /styleguide page is where they are shown in every state.
 *
 * `data-force="hover|focus|active"` pins a state for the style guide only.
 */

export type ButtonKind = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-gh-pill border font-brand font-medium transition-colors duration-gh-fast ease-gh " +
  "focus-visible:outline-none focus-visible:shadow-gh-ring data-[force=focus]:shadow-gh-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

const BUTTON_KIND: Record<ButtonKind, string> = {
  primary:
    "border-signal bg-signal text-signal-ink hover:brightness-[1.06] data-[force=hover]:brightness-[1.06] active:brightness-95 data-[force=active]:brightness-95",
  secondary:
    "border-line-strong bg-surface-raised text-ink hover:bg-tint data-[force=hover]:bg-tint active:bg-line data-[force=active]:bg-line",
  ghost:
    "border-transparent bg-transparent text-ink hover:bg-tint data-[force=hover]:bg-tint active:bg-line data-[force=active]:bg-line",
  danger:
    "border-danger-ink bg-transparent text-danger-ink hover:bg-danger-ink/10 data-[force=hover]:bg-danger-ink/10 active:bg-danger-ink/20 data-[force=active]:bg-danger-ink/20",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "min-h-8 px-3 text-gh-sm",
  // 44px touch target on phones, 36px from sm up.
  md: "min-h-11 px-4 text-gh-base sm:min-h-9",
};

export function buttonClass(kind: ButtonKind, size: ButtonSize = "md", extra = ""): string {
  return `${BUTTON_BASE} ${BUTTON_KIND[kind]} ${BUTTON_SIZE[size]} ${extra}`.trim();
}

export const INPUT_CLASS =
  "block w-full min-h-11 rounded-gh-md border border-line-strong bg-surface-raised px-3 text-gh-base text-ink placeholder:text-muted sm:min-h-9 " +
  "focus-visible:outline-none focus-visible:shadow-gh-ring data-[force=focus]:shadow-gh-ring " +
  "aria-[invalid=true]:border-danger-ink disabled:cursor-not-allowed disabled:bg-tint disabled:text-muted";

export function tabClass(selected: boolean): string {
  return (
    "-mb-px shrink-0 border-b-2 px-4 py-2.5 text-gh-sm font-medium transition-colors duration-gh-fast focus-visible:outline-none focus-visible:shadow-gh-ring " +
    (selected ? "border-signal text-ink" : "border-transparent text-muted hover:text-ink data-[force=hover]:text-ink")
  );
}

export type ChipKind = "human" | "agent" | "neutral";

export function chipClass(kind: ChipKind): string {
  const tick = kind === "human" ? "before:bg-human" : kind === "agent" ? "before:bg-agent" : "before:bg-line-strong";
  return (
    "inline-flex items-center gap-1.5 rounded-gh-pill border border-line bg-surface-raised px-2.5 py-0.5 text-gh-sm text-ink " +
    `before:inline-block before:h-2 before:w-2 before:rounded-full before:content-[''] ${tick}`
  );
}

export const CARD_CLASS = "rounded-gh-lg border border-line bg-surface-raised p-4 shadow-gh-1";
export const FROST_PANEL_CLASS = "gh-frost rounded-gh-lg border border-line shadow-gh-2";
export const LABEL_CLASS = "gh-label text-muted";
export const MENU_CLASS = "min-w-[12rem] rounded-gh-md border border-line bg-surface-raised p-1 shadow-gh-3";

export function menuItemClass(opts: { danger?: boolean; checked?: boolean } = {}): string {
  return (
    "flex w-full min-h-11 items-center justify-between gap-3 rounded-gh-sm px-3 text-left text-gh-sm sm:min-h-9 " +
    "hover:bg-tint data-[force=hover]:bg-tint focus-visible:outline-none focus-visible:shadow-gh-ring disabled:text-muted disabled:hover:bg-transparent " +
    (opts.danger ? "text-danger-ink" : "text-ink") +
    (opts.checked ? " font-medium" : "")
  );
}

export const NOTICE_CLASS = {
  error: "rounded-gh-md border border-danger-ink/60 bg-danger-ink/5 px-3 py-2 text-gh-sm",
  refusal: "rounded-gh-md border border-line-strong bg-tint px-3 py-2 text-gh-sm",
} as const;

/** A native select in the input's frame, with room for the browser's arrow. */
export const SELECT_CLASS = `${INPUT_CLASS} pr-8`;

/** Checkbox and radio: native control, signal accent, the brand ring. 44px row on phones comes from the label. */
export const CHECKBOX_CLASS =
  "h-4 w-4 shrink-0 cursor-pointer rounded-gh-sm border-line-strong accent-[var(--gh-signal)] focus-visible:outline-none focus-visible:shadow-gh-ring disabled:cursor-not-allowed disabled:opacity-50";

/** A round icon-only control (search, menu, close): 44px on phones, 36px from sm. */
export const ICON_BUTTON_CLASS =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-gh-pill border border-line-strong bg-surface-raised text-ink transition-colors duration-gh-fast hover:bg-tint focus-visible:outline-none focus-visible:shadow-gh-ring";

/** The unread count on the bar: signal with its ink label (white on signal fails AA). */
export const BADGE_CLASS =
  "inline-flex min-w-[1.25rem] items-center justify-center rounded-gh-pill bg-signal px-1.5 font-brand-mono text-[11px] leading-5 tabular-nums text-signal-ink";

/** A section link on the bar. Full-width row in the phone disclosure, inline from sm. */
export function navLinkClass(current: boolean): string {
  return (
    "rounded-gh-md px-3 py-3 text-gh-sm transition-colors duration-gh-fast hover:bg-tint hover:text-ink focus-visible:outline-none focus-visible:shadow-gh-ring " +
    "sm:rounded-gh-pill sm:px-3 sm:py-1.5 " +
    (current ? "font-medium text-ink sm:bg-tint" : "text-muted")
  );
}

/** Mono uppercase heading inside a menu (Appearance, You). */
export const MENU_HEADING_CLASS = "gh-label px-3 pb-1 pt-2 text-muted";

/* Page recipes (rollout #75). Pages compose these so a card, a table or an
   empty state reads the same on /explore, /s, /a, /me, /inbox and /mod. */

/** The one page title (h1): display weight, tight tracking. */
export const PAGE_TITLE_CLASS = "font-brand text-gh-2xl font-extrabold tracking-[-0.02em] text-ink sm:text-gh-3xl";
/** A section heading (h2) inside a page. */
export const SECTION_TITLE_CLASS = "font-brand text-gh-lg font-bold tracking-[-0.01em] text-ink";
/** A quiet section: a surface with a hairline, no shadow (Manage and Settings groups). */
export const SECTION_CLASS = "rounded-gh-lg border border-line bg-surface p-4 sm:p-5";
/** An inline text link: ink with a visible underline (signal is never a link colour). */
export const LINK_CLASS =
  "text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink focus-visible:outline-none focus-visible:shadow-gh-ring rounded-gh-sm";
/** Nothing here yet: dashed frame, one terse line, optional action below. */
export const EMPTY_CLASS = "rounded-gh-lg border border-dashed border-line-strong bg-surface px-4 py-6 text-center text-gh-sm text-muted";
/** A data table scrolls inside its own frame at 390px; the page never scrolls sideways. */
export const TABLE_WRAP_CLASS = "overflow-x-auto rounded-gh-lg border border-line bg-surface-raised";
export const TABLE_CLASS = "w-full border-collapse text-left text-gh-sm text-ink";
export const TH_CLASS = "gh-label whitespace-nowrap border-b border-line px-3 py-2 text-left font-normal text-muted";
export const TD_CLASS = "border-t border-line px-3 py-2 align-top";
/** A count, clock or amount: mono, tabular. */
export const NUM_CLASS = "font-brand-mono tabular-nums";
/** A textarea in the input frame. */
export const TEXTAREA_CLASS = `${INPUT_CLASS} py-2 leading-relaxed`;
/** A small status pill with a word (Open, delivered, pending…): tone classes come from the caller. */
export const PILL_CLASS = "inline-flex items-center gap-1 rounded-gh-pill border px-2 py-0.5 text-gh-xs";
/** Selected / unselected option tile (create flow, plot pickers, theme choices). */
export function optionClass(selected: boolean): string {
  return (
    "rounded-gh-lg border p-3 text-left transition-colors duration-gh-fast focus-visible:outline-none focus-visible:shadow-gh-ring " +
    (selected ? "border-signal bg-tint text-ink" : "border-line bg-surface-raised text-ink hover:bg-tint")
  );
}
