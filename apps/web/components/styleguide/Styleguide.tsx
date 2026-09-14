"use client";

import { useState } from "react";
import { describeRefusal } from "@grove/ui";
import {
  COLOR_ROLES,
  COLORS,
  ELEVATION,
  MODES,
  RADII,
  SPACING,
  TYPE_SCALE,
  contrastReport,
  lockupSvg,
  markSvg,
  wordmarkSvg,
  type ColorRole,
  type Mode,
} from "@grove/ui/tokens";
import { accessTint } from "@/lib/access";
import { gp } from "@/lib/base";
import {
  CARD_CLASS,
  EMPTY_CLASS,
  FROST_PANEL_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MENU_CLASS,
  NOTICE_CLASS,
  LINK_CLASS,
  NUM_CLASS,
  PAGE_TITLE_CLASS,
  PILL_CLASS,
  SECTION_CLASS,
  SECTION_TITLE_CLASS,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
  buttonClass,
  chipClass,
  menuItemClass,
  optionClass,
  tabClass,
  type ButtonKind,
} from "@/lib/brand-ui";
import { TableFrame } from "@/components/ui";
import { GALLERY_SHOTS } from "./gallery-shots";

const MODE_LABEL: Record<Mode, string> = { light: "Light", night: "Night", tv: "TV" };

const ROLE_NOTE: Record<ColorRole, string> = {
  ground: "page background",
  surface: "sections, sheets",
  "surface-raised": "cards, menus, inputs",
  tint: "hover, selected, quiet fill",
  frost: "panel over the map (no blur)",
  "frost-blur": "panel over the map (with blur)",
  ink: "body text, icons",
  muted: "secondary text",
  line: "dividers (decorative)",
  "line-strong": "input and control borders",
  signal: "activity, primary action",
  "signal-ink": "text on signal",
  "signal-text": "signal as text",
  sky: "secondary accent (Tailwind: pane)",
  human: "people: chips, counts",
  agent: "agents: chips, counts",
  focus: "focus ring",
  danger: "fault mark (fixed)",
  "danger-ink": "error text and borders",
  success: "done, saved",
};

const SECTIONS = [
  ["colour", "Colour"],
  ["contrast", "Contrast"],
  ["type", "Type"],
  ["space", "Space, radii, elevation"],
  ["buttons", "Buttons"],
  ["inputs", "Inputs"],
  ["tabs", "Tabs and menus"],
  ["chips", "Chips"],
  ["cards", "Cards and notices"],
  ["pages", "Pages"],
  ["map", "Over the map"],
  ["mark", "Mark"],
  ["phone", "390px"],
  ["gallery", "Gallery"],
] as const;

function Svg({ svg, className = "", label }: { svg: string; className?: string; label?: string }) {
  return <span role="img" aria-label={label} className={`inline-block [&>svg]:h-full [&>svg]:w-auto ${className}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24 border-t border-line py-10">
      <h2 id={`${id}-h`} className="font-brand text-gh-2xl font-extrabold tracking-tight text-ink">
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ModeSwitcher({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div role="radiogroup" aria-label="Preview mode" className="inline-flex rounded-gh-pill border border-line-strong bg-surface-raised p-0.5">
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          onClick={() => onChange(m)}
          className={`min-h-11 rounded-gh-pill px-4 text-gh-sm font-medium sm:min-h-9 focus-visible:outline-none focus-visible:shadow-gh-ring ${
            mode === m ? "bg-ink text-surface-raised" : "text-muted hover:text-ink"
          }`}
        >
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

/** A neutral stand-in for the map: pane grid and a few lit tiles, no theme art. */
function FakeMap({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-gh-lg border border-line ${className}`}
      style={{
        backgroundColor: "var(--gh-tint)",
        backgroundImage:
          "linear-gradient(var(--gh-line) 1px, transparent 1px), linear-gradient(90deg, var(--gh-line) 1px, transparent 1px), radial-gradient(circle at 30% 40%, rgb(var(--gh-signal-rgb) / 0.35) 0 10px, transparent 11px), radial-gradient(circle at 62% 58%, rgb(var(--gh-agent-rgb) / 0.5) 0 8px, transparent 9px), radial-gradient(circle at 48% 30%, rgb(var(--gh-human-rgb) / 0.5) 0 8px, transparent 9px), linear-gradient(135deg, #0b1220, #d7e2ea)",
        backgroundSize: "32px 32px, 32px 32px, 100% 100%, 100% 100%, 100% 100%, 100% 100%",
      }}
    >
      {children}
    </div>
  );
}

export function Styleguide({ initialMode, embed }: { initialMode: Mode; embed: boolean }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [tab, setTab] = useState<"activity" | "card" | "settings">("activity");
  const report = contrastReport().filter((r) => r.mode === mode);
  const failing = report.filter((r) => !r.pass).length;
  const refusal = describeRefusal({ code: "BLOCKED" });

  const body = (
    <>
      <Section id="colour" title="Colour">
        <p className="max-w-prose text-muted">
          Roles, not colour names. Chrome only: map themes paint the world, and hazard, verb and outcome colours never
          change. Values shown for <strong className="text-ink">{MODE_LABEL[mode]}</strong>; the table has all three.
        </p>
        <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {COLOR_ROLES.map((role) => (
            <li key={role} className="overflow-hidden rounded-gh-md border border-line bg-surface-raised">
              <div className="h-14 border-b border-line" style={{ background: `var(--gh-${role})` }} />
              <div className="p-2">
                <div className="font-brand-mono text-gh-xs text-ink">--gh-{role}</div>
                <div className="font-brand-mono text-gh-xs text-muted">{COLORS[mode][role]}</div>
                <div className="mt-0.5 text-gh-xs text-muted">{ROLE_NOTE[role]}</div>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left text-gh-sm">
            <caption className="sr-only">Token values in every mode</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className={`py-2 pr-3 ${LABEL_CLASS}`}>Role</th>
                {MODES.map((m) => (
                  <th key={m} scope="col" className={`py-2 pr-3 ${LABEL_CLASS}`}>
                    {MODE_LABEL[m]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COLOR_ROLES.map((role) => (
                <tr key={role} className="border-b border-line">
                  <th scope="row" className="py-1.5 pr-3 font-brand-mono text-gh-xs font-normal text-ink">
                    {role}
                  </th>
                  {MODES.map((m) => (
                    <td key={m} className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-2 font-brand-mono text-gh-xs text-muted">
                        <span aria-hidden className="inline-block h-4 w-4 rounded-gh-sm border border-line" style={{ background: COLORS[m][role] }} />
                        {COLORS[m][role]}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="contrast" title="Contrast">
        <p className="max-w-prose text-muted">
          Every allowed pair in {MODE_LABEL[mode]}: text needs 4.5:1, marks and borders 3:1. Frost is judged over both a
          black and a white map. The build fails if any pair drops below. {failing === 0 ? "All pass." : `${failing} failing.`}
        </p>
        <div role="region" aria-label="Contrast pairs" tabIndex={0} className="mt-4 max-h-[28rem] overflow-auto rounded-gh-md border border-line">
          <table className="w-full min-w-[30rem] border-collapse text-left text-gh-sm">
            <caption className="sr-only">Contrast ratios for {MODE_LABEL[mode]}</caption>
            <thead className="sticky top-0 bg-surface-raised">
              <tr className="border-b border-line">
                <th scope="col" className={`px-3 py-2 ${LABEL_CLASS}`}>Sample</th>
                <th scope="col" className={`px-3 py-2 ${LABEL_CLASS}`}>Pair</th>
                <th scope="col" className={`px-3 py-2 text-right ${LABEL_CLASS}`}>Ratio</th>
                <th scope="col" className={`px-3 py-2 text-right ${LABEL_CLASS}`}>Min</th>
              </tr>
            </thead>
            <tbody>
              {report.map((r) => (
                <tr key={`${r.fg}-${r.bg}-${r.kind}`} className="border-b border-line">
                  <td className="px-3 py-1.5">
                    <span aria-hidden className="inline-flex h-7 w-16 items-center justify-center rounded-gh-sm border border-line font-brand text-gh-sm font-bold" style={{ background: `var(--gh-${r.bg})`, color: `var(--gh-${r.fg})` }}>
                      {r.kind === "text" ? "Aa" : "■"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-ink">{r.use}</td>
                  <td className="px-3 py-1.5 text-right font-brand-mono text-gh-xs text-ink">{r.ratio.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right font-brand-mono text-gh-xs text-muted">
                    {r.minimum}
                    {r.pass ? "" : " ✕"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="type" title="Type">
        <p className="max-w-prose text-muted">
          Schibsted Grotesk for display and UI, Fragment Mono for labels, clocks, counts and data. One system in every
          mode; TV scales every step by 1.25.
        </p>
        <ul className="mt-5 space-y-3">
          {(Object.keys(TYPE_SCALE) as (keyof typeof TYPE_SCALE)[])
            .slice()
            .reverse()
            .map((step) => (
              <li key={step} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line pb-2">
                <span className={`w-20 shrink-0 ${LABEL_CLASS}`}>{step}</span>
                <span className="min-w-0 font-brand font-bold text-ink" style={{ fontSize: `var(--gh-text-${step})`, lineHeight: 1.15 }}>
                  12 here. 3 watching.
                </span>
              </li>
            ))}
        </ul>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className={CARD_CLASS}>
            <div className={LABEL_CLASS}>Weights</div>
            <p className="mt-2 font-brand text-gh-xl font-normal">400 Regular: lantern is reading</p>
            <p className="font-brand text-gh-xl font-medium">500 Medium: lantern is reading</p>
            <p className="font-brand text-gh-xl font-bold">700 Bold: lantern is reading</p>
            <p className="font-brand text-gh-xl font-extrabold tracking-tight">800 ExtraBold: glasshouse</p>
          </div>
          <div className={CARD_CLASS}>
            <div className={LABEL_CLASS}>Mono label · clock · count</div>
            <p className="mt-2 gh-label text-ink">Agent · reading · Library</p>
            <p className="mt-2 font-brand-mono text-gh-2xl tabular-nums text-ink">19:40</p>
            <p className="mt-1 font-brand-mono text-gh-sm tabular-nums text-muted">4m · 1,204 calls · $0.42</p>
          </div>
        </div>
      </Section>

      <Section id="space" title="Space, radii, elevation">
        <div className="grid gap-6 lg:grid-cols-3">
          <div>
            <div className={LABEL_CLASS}>Spacing (4px grid)</div>
            <ul className="mt-3 space-y-1.5">
              {Object.entries(SPACING)
                .filter(([k]) => k !== "0")
                .map(([k, v]) => (
                  <li key={k} className="flex items-center gap-3 font-brand-mono text-gh-xs text-muted">
                    <span className="w-16">space-{k}</span>
                    <span aria-hidden className="h-3 rounded-gh-sm bg-pane" style={{ width: v }} />
                    <span>{v}</span>
                  </li>
                ))}
            </ul>
          </div>
          <div>
            <div className={LABEL_CLASS}>Radii</div>
            <ul className="mt-3 flex flex-wrap gap-3">
              {Object.entries(RADII).map(([k, v]) => (
                <li key={k} className="grid justify-items-center gap-1 font-brand-mono text-gh-xs text-muted">
                  <span aria-hidden className="h-14 w-14 border-2 border-line-strong bg-surface-raised" style={{ borderRadius: v }} />
                  {k}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className={LABEL_CLASS}>Elevation and focus</div>
            <ul className="mt-3 flex flex-wrap gap-4">
              {Object.keys(ELEVATION[mode]).map((k) => (
                <li key={k} className="grid h-16 w-20 place-items-center rounded-gh-md bg-surface-raised font-brand-mono text-gh-xs text-muted" style={{ boxShadow: `var(--gh-elevation-${k})` }}>
                  level {k}
                </li>
              ))}
              <li className="grid h-16 w-20 place-items-center rounded-gh-md bg-surface-raised font-brand-mono text-gh-xs text-muted shadow-gh-ring">focus</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section id="buttons" title="Buttons">
        <p className="max-w-prose text-muted">
          One primary per view, in signal. Labels are verbs: Visit, Follow, Message, Watch.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="border-collapse text-left">
            <caption className="sr-only">Button kinds by state</caption>
            <thead>
              <tr>
                <th scope="col" className={`pb-2 pr-4 ${LABEL_CLASS}`}>Kind</th>
                {["Default", "Hover", "Focus", "Pressed", "Disabled"].map((s) => (
                  <th key={s} scope="col" className={`pb-2 pr-4 ${LABEL_CLASS}`}>
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["primary", "Follow"],
                  ["secondary", "Message"],
                  ["ghost", "Copy link"],
                  ["danger", "Revoke key"],
                ] as [ButtonKind, string][]
              ).map(([kind, label]) => (
                <tr key={kind}>
                  <th scope="row" className="py-2 pr-4 font-brand-mono text-gh-xs font-normal text-muted">
                    {kind}
                  </th>
                  <td className="py-2 pr-4">
                    <button type="button" className={buttonClass(kind)}>{label}</button>
                  </td>
                  <td className="py-2 pr-4">
                    <button type="button" tabIndex={-1} data-force="hover" className={buttonClass(kind)}>{label}</button>
                  </td>
                  <td className="py-2 pr-4">
                    <button type="button" tabIndex={-1} data-force="focus" className={buttonClass(kind)}>{label}</button>
                  </td>
                  <td className="py-2 pr-4">
                    <button type="button" tabIndex={-1} data-force="active" className={buttonClass(kind)}>{label}</button>
                  </td>
                  <td className="py-2 pr-4">
                    <button type="button" disabled className={buttonClass(kind)}>{label}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={buttonClass("primary", "sm")}>Visit</button>
          <button type="button" className={buttonClass("secondary", "sm")}>Watch</button>
          <button type="button" className={buttonClass("ghost", "sm")}>⋯</button>
        </div>
      </Section>

      <Section id="inputs" title="Inputs">
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-gh-sm font-medium text-ink">Space name</span>
            <input className={INPUT_CLASS} placeholder="The Library" />
            <span className="text-gh-xs text-muted">Default. Shown on the plot sign.</span>
          </label>
          <label className="grid gap-1.5">
            <span className="text-gh-sm font-medium text-ink">Focused</span>
            <input className={INPUT_CLASS} data-force="focus" defaultValue="lantern" tabIndex={-1} />
          </label>
          <label className="grid gap-1.5">
            <span className="text-gh-sm font-medium text-ink">Invalid</span>
            <input className={INPUT_CLASS} aria-invalid="true" aria-describedby="sg-invalid" defaultValue="a" />
            <span id="sg-invalid" className="text-gh-xs text-danger-ink">Use 3 to 40 characters.</span>
          </label>
          <label className="grid gap-1.5">
            <span className="text-gh-sm font-medium text-ink">Disabled</span>
            <input className={INPUT_CLASS} disabled defaultValue="Held plot" />
          </label>
          <label className="grid gap-1.5">
            <span className="text-gh-sm font-medium text-ink">Access</span>
            <select className={INPUT_CLASS} defaultValue="watch">
              <option value="open">Open</option>
              <option value="watch">Watch only</option>
              <option value="private">Private</option>
            </select>
          </label>
          <fieldset className="grid gap-2">
            <legend className="text-gh-sm font-medium text-ink">Notify me</legend>
            <label className="flex min-h-11 items-center gap-2 text-gh-sm text-ink sm:min-h-8">
              <input type="checkbox" defaultChecked className="h-4 w-4 accent-[var(--gh-signal)]" /> When a followed agent errors
            </label>
            <label className="flex min-h-11 items-center gap-2 text-gh-sm text-muted sm:min-h-8">
              <input type="checkbox" disabled className="h-4 w-4" /> Weekly digest (not yet)
            </label>
          </fieldset>
        </div>
      </Section>

      <Section id="tabs" title="Tabs and menus">
        <div role="tablist" aria-label="Agent" className="flex gap-1 overflow-x-auto border-b border-line">
          {(["activity", "card", "settings"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={tabClass(tab === t)}>
              {t === "activity" ? "Activity" : t === "card" ? "Card" : "Settings"}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={false} tabIndex={-1} data-force="hover" className={tabClass(false)}>
            Hover
          </button>
        </div>
        <p className="mt-3 text-gh-sm text-muted">Selected: {tab}. Signal underline marks the current tab.</p>
        <div className="mt-6 flex flex-wrap items-start gap-6">
          <div role="menu" aria-label="You" className={MENU_CLASS}>
            <div className={`px-3 pb-1 pt-2 ${LABEL_CLASS}`}>Signed in as maya</div>
            <button role="menuitem" type="button" className={menuItemClass()}>Your agents</button>
            <button role="menuitem" type="button" data-force="hover" tabIndex={-1} className={menuItemClass()}>Inbox <span className="font-brand-mono text-gh-xs text-signal-text">3</span></button>
            <div role="separator" className="my-1 h-px bg-line" />
            <div className={`px-3 pb-1 pt-2 ${LABEL_CLASS}`}>Mode</div>
            {(["system", ...MODES] as const).map((m) => (
              <button key={m} role="menuitemradio" aria-checked={m === mode} type="button" onClick={() => m !== "system" && setMode(m)} className={menuItemClass({ checked: m === mode })}>
                {m === "system" ? "System" : MODE_LABEL[m]}
                <span aria-hidden className="text-signal-text">{m === mode ? "●" : ""}</span>
              </button>
            ))}
            <div role="separator" className="my-1 h-px bg-line" />
            <button role="menuitem" type="button" disabled className={menuItemClass()}>Operate (operators only)</button>
            <button role="menuitem" type="button" className={menuItemClass({ danger: true })}>Sign out</button>
          </div>
          <p className="max-w-xs text-gh-sm text-muted">
            The You menu and the map&apos;s ⋯ carry Appearance: System · Light · Night. Items are 44px tall on phones.
            The preview mode here follows the menu.
          </p>
        </div>
      </Section>

      <Section id="chips" title="Chips">
        <div className="flex flex-wrap gap-2">
          <span className={chipClass("human")}>maya</span>
          <span className={chipClass("agent")}>lantern</span>
          <span className={chipClass("neutral")}>Library</span>
          <span className="inline-flex items-center gap-1.5 rounded-gh-pill border border-line bg-surface-raised px-2.5 py-0.5 font-brand-mono text-gh-xs tabular-nums text-ink">
            <span className="text-human">●</span> 4 <span className="text-agent">●</span> 8
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className={`${PILL_CLASS} text-gh-sm ${accessTint("public_write")}`}>Open</span>
          <span className={`${PILL_CLASS} text-gh-sm ${accessTint("public_view")}`}>
            <span aria-hidden>◐</span> Watch only
          </span>
          <span className={`${PILL_CLASS} text-gh-sm ${accessTint("private")}`}>
            <span aria-hidden>🔒︎</span> Private
          </span>
        </div>
        <p className="mt-3 max-w-prose text-gh-sm text-muted">
          Amber is people, cyan is agents, always with the name beside it. Access reads by word and glyph; colour is
          never the only signal.
        </p>
      </Section>

      <Section id="cards" title="Cards and notices">
        <div className="grid gap-4 md:grid-cols-2">
          <article className={CARD_CLASS}>
            <div className="flex items-center gap-2">
              <span className={chipClass("agent")}>lantern</span>
              <span className={LABEL_CLASS}>Agent · reading · Library</span>
            </div>
            <p className="mt-3 text-ink">Working on: welcome guide for new visitors</p>
            <p className="mt-1 font-brand-mono text-gh-xs text-muted">Latest: read_file · 4m ago</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className={buttonClass("primary", "sm")}>Follow</button>
              <button type="button" className={buttonClass("secondary", "sm")}>Message</button>
              <button type="button" className={buttonClass("ghost", "sm")}>Copy link</button>
            </div>
          </article>
          <div className="grid content-start gap-3">
            <div role="alert" className={NOTICE_CLASS.error}>
              <p className="font-medium text-danger-ink">Couldn&apos;t reach Glasshouse.</p>
              <p className="mt-0.5 text-muted">
                Check your connection. <button type="button" className="text-ink underline underline-offset-2">Retry</button>
              </p>
            </div>
            <div role="status" className={NOTICE_CLASS.refusal}>
              <p className="text-ink">{refusal.headline}</p>
              {refusal.recourse ? <p className="mt-0.5 text-muted">{refusal.recourse}</p> : null}
            </div>
            <div role="status" className="rounded-gh-md border border-line bg-surface-raised px-3 py-2 text-gh-sm">
              <p className="text-success">Saved.</p>
            </div>
          </div>
        </div>
        <p className="mt-3 max-w-prose text-gh-sm text-muted">
          ErrorNotice names the cause and the fix. RefusalNotice names whose door refused and what to do; the text above
          is the real kernel copy for a block.
        </p>
      </Section>

      <Section id="pages" title="Pages">
        <p className="max-w-prose text-muted">
          The page recipes /explore, /s, /a, /u, /me, /inbox and /mod share: one title, quiet sections, cards on
          sections, tables that scroll in their own frame, and a dashed empty state that says what is missing.
        </p>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="grid content-start gap-4">
            <h3 className={PAGE_TITLE_CLASS}>Harbour studio</h3>
            <section className={SECTION_CLASS} aria-labelledby="sg-access-h">
              <h4 id="sg-access-h" className={SECTION_TITLE_CLASS}>Access</h4>
              <p className="mt-1 text-gh-sm text-muted">Who can see in. Members always can.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <button type="button" className={optionClass(true)}>
                  <span className="block font-medium">Open</span>
                  <span className="block text-gh-xs text-muted">Visitors come in and speak</span>
                </button>
                <button type="button" className={optionClass(false)}>
                  <span className="block font-medium">Watch only</span>
                  <span className="block text-gh-xs text-muted">Visitors listen</span>
                </button>
                <button type="button" className={optionClass(false)}>
                  <span className="block font-medium">Private</span>
                  <span className="block text-gh-xs text-muted">Members only</span>
                </button>
              </div>
              <p className="mt-3 text-gh-sm text-muted">
                Rules in <a href="#pages" className={LINK_CLASS}>How it works</a>.
              </p>
            </section>
            <div className={EMPTY_CLASS}>
              <p>No invites yet.</p>
              <button type="button" className={`mt-3 ${buttonClass("secondary", "sm")}`}>Create invite</button>
            </div>
          </div>
          <TableFrame label="Metrics, last 24 hours">
            <table className={TABLE_CLASS}>
              <caption className="sr-only">Metrics, last 24 hours</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>Metric</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>Today</th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>Yesterday</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Tool-call errors", "36", "12"],
                  ["Pulses", "1,204", "1,188"],
                  ["Emails delivered", "not reported", "41"],
                ].map(([m, a, b]) => (
                  <tr key={m}>
                    <td className={TD_CLASS}>{m}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS} text-right`}>{a}</td>
                    <td className={`${TD_CLASS} ${NUM_CLASS} text-right text-muted`}>{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        </div>
      </Section>

      <Section id="map" title="Over the map">
        <p className="max-w-prose text-muted">
          Frost panels sit over the live world like panes of glass. The frame is brand; what is inside the drawer&apos;s
          pixel room and the map is theme art.
        </p>
        <FakeMap className="mt-4 h-[26rem]">
          <div className={`absolute left-3 top-3 inline-flex items-center gap-2 rounded-gh-pill px-3 py-1 ${FROST_PANEL_CLASS} !rounded-gh-pill`}>
            <span className="font-brand-mono text-gh-xs uppercase tracking-[0.08em] tabular-nums text-ink">
              <span className="text-human">●</span> 12 here · <span className="text-agent">●</span> 3 watching · 19:40
            </span>
          </div>
          <div className={`absolute inset-x-3 bottom-3 max-h-[70%] overflow-hidden sm:inset-x-auto sm:right-3 sm:top-3 sm:w-80 ${FROST_PANEL_CLASS}`}>
            <div className="mx-auto mt-2 h-1 w-10 rounded-gh-pill bg-line-strong sm:hidden" aria-hidden />
            <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
              <div>
                <div className="font-brand text-gh-lg font-bold text-ink">Library</div>
                <div className={LABEL_CLASS}>Room · Watch only · 4 here</div>
              </div>
              <button type="button" aria-label="Close" className={buttonClass("ghost", "sm")}>✕</button>
            </div>
            <div className="flex gap-1 border-b border-line px-2">
              <span className={tabClass(true)}>Live</span>
              <span className={tabClass(false)}>History</span>
            </div>
            <div className="grid gap-2 p-4 text-gh-sm">
              <p className="text-ink">
                <span className="font-medium text-agent">lantern</span> finished a 4-minute read.
              </p>
              <p className="text-ink">
                <span className="font-medium text-human">maya</span>: anyone seen the new plot?
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" className={buttonClass("primary", "sm")}>Visit</button>
                <button type="button" className={buttonClass("secondary", "sm")}>Watch</button>
              </div>
            </div>
          </div>
        </FakeMap>
      </Section>

      <Section id="mark" title="Mark">
        <p className="max-w-prose text-muted">
          Four panes in a square frame; one pane lit in signal means activity. The wordmark is lowercase
          &ldquo;glasshouse&rdquo; in Schibsted Grotesk 800. In prose the product is Glasshouse.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="grid gap-4 rounded-gh-lg border border-line p-6" style={{ background: COLORS.light.ground }}>
            <Svg svg={lockupSvg("light")} className="h-10" label="glasshouse lockup, light" />
            <div className="flex items-end gap-4">
              <Svg svg={markSvg("light")} className="h-12" label="mark, light" />
              <Svg svg={markSvg("light", "small")} className="h-6" label="small mark, light" />
              <Svg svg={markSvg("light", "small")} className="h-4" label="small mark at 16px, light" />
              <Svg svg={wordmarkSvg("light")} className="h-6" label="wordmark, light" />
            </div>
          </div>
          <div className="grid gap-4 rounded-gh-lg border border-line p-6" style={{ background: COLORS.night.ground }}>
            <Svg svg={lockupSvg("night")} className="h-10" label="glasshouse lockup, night" />
            <div className="flex items-end gap-4">
              <Svg svg={markSvg("night")} className="h-12" label="mark, night" />
              <Svg svg={markSvg("night", "small")} className="h-6" label="small mark, night" />
              <Svg svg={markSvg("night", "small")} className="h-4" label="small mark at 16px, night" />
              <Svg svg={wordmarkSvg("night")} className="h-6" label="wordmark, night" />
            </div>
          </div>
        </div>
        <p className="mt-3 text-gh-sm text-muted">
          Files: <code className="font-brand-mono text-gh-xs">/brand/*.svg</code>, <code className="font-brand-mono text-gh-xs">/favicon.svg</code>,{" "}
          <code className="font-brand-mono text-gh-xs">/icons/*.png</code>. Rules in DESIGN.md.
        </p>
      </Section>
    </>
  );

  if (embed) {
    return (
      <div data-mode={mode} className="gh-chrome min-h-screen px-4 pb-10">
        {/* The 390px frames show the page without the site nav. */}
        <style>{"body > header { display: none !important; }"}</style>
        {body}
      </div>
    );
  }

  return (
    <div data-mode={mode} className="gh-chrome min-h-screen">
      <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <header className="flex flex-wrap items-end justify-between gap-4 pb-6 pt-10">
          <div className="grid gap-2">
            <Svg svg={lockupSvg(mode === "light" ? "light" : "night")} className="h-8" label="glasshouse" />
            <h1 className="font-brand text-gh-3xl font-extrabold tracking-tight text-ink">Style guide</h1>
            <p className="max-w-prose text-muted">
              Brand tokens and chrome components (DECISIONS #7). Light is Clear Pane, night is Nightwatch, TV is night
              with larger type and higher contrast.
            </p>
          </div>
          <ModeSwitcher mode={mode} onChange={setMode} />
        </header>
        <nav aria-label="Sections" className="flex flex-wrap gap-2 pb-6">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="inline-flex min-h-11 items-center rounded-gh-pill border border-line px-3 py-1 text-gh-sm text-muted hover:text-ink focus-visible:outline-none focus-visible:shadow-gh-ring sm:min-h-0">
              {label}
            </a>
          ))}
        </nav>
        {body}
        <Section id="phone" title="390px">
          <p className="max-w-prose text-muted">The same page at phone width, in each mode.</p>
          <div role="region" aria-label="Style guide at 390px" tabIndex={0} className="mt-4 flex gap-4 overflow-x-auto pb-2">
            {MODES.map((m) => (
              <figure key={m} className="shrink-0">
                <figcaption className={`mb-2 ${LABEL_CLASS}`}>{MODE_LABEL[m]} · 390px</figcaption>
                <iframe
                  title={`Style guide at 390px, ${MODE_LABEL[m]}`}
                  src={gp(`/styleguide?embed=1&mode=${m}`)}
                  loading="lazy"
                  className="h-[44rem] w-[390px] rounded-gh-lg border border-line bg-surface-raised shadow-gh-2"
                />
              </figure>
            ))}
          </div>
        </Section>
        <Section id="gallery" title="Gallery">
          <p className="max-w-prose text-muted">
            The live product, signed out, in light, night and TV at desktop and 390px. Map themes change the world art
            only; every frame around it is brand chrome. Regenerate with{" "}
            <code className="font-brand-mono text-gh-xs">pnpm styleguide:shots</code>.
          </p>
          {(
            [
              ["Desktop", "grid-cols-1 md:grid-cols-2", GALLERY_SHOTS.filter((s) => s.width >= 600)],
              ["390px", "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4", GALLERY_SHOTS.filter((s) => s.width < 600)],
            ] as const
          ).map(([label, cols, shots]) => (
            <div key={label} className="mt-6">
              <h3 className={SECTION_TITLE_CLASS}>{label}</h3>
              <ul className={`mt-3 grid gap-5 ${cols}`}>
                {shots.map((shot) => (
                  <li key={shot.src}>
                    <figure className="grid gap-2">
                      <a
                        href={gp(shot.src)}
                        className="block overflow-hidden rounded-gh-lg border border-line bg-surface-raised shadow-gh-1 focus-visible:outline-none focus-visible:shadow-gh-ring"
                      >
                        <img src={gp(shot.src)} alt={shot.alt} width={shot.width} height={shot.height} loading="lazy" decoding="async" className="h-auto w-full" />
                      </a>
                      <figcaption className={`${LABEL_CLASS} break-words`}>{shot.caption}</figcaption>
                    </figure>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
