import type { ReactNode } from "react";
import { identityTextClass, identityTickClass, identityWord, type IdentityKind } from "@/lib/identity";

/**
 * Human amber / agent cyan in the chrome (DECISIONS #7). Always beside a name
 * or a word: the tick is decoration for sighted readers, the word is the fact.
 */
export function IdentityTick({ kind, className = "" }: { kind: IdentityKind; className?: string }) {
  return (
    <span data-identity={kind} className={`${identityTickClass(kind)} ${className}`} title={identityWord(kind)} aria-hidden />
  );
}

/** A name with its tick in front, e.g. in a roster line or a card title. */
export function IdentityName({ kind, children, className = "" }: { kind: IdentityKind; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <IdentityTick kind={kind} />
      <span className="min-w-0 truncate">{children}</span>
      <span className="sr-only"> ({identityWord(kind).toLowerCase()})</span>
    </span>
  );
}

/** A chip: tick + kind word, for card eyebrows and rosters. */
export function IdentityChip({ kind, className = "" }: { kind: IdentityKind; className?: string }) {
  return (
    <span
      data-identity={kind}
      className={`inline-flex items-center gap-1.5 rounded-gh-pill border border-line bg-surface-raised px-2 py-0.5 gh-label ${identityTextClass(kind)} ${className}`}
    >
      <span className={identityTickClass(kind)} aria-hidden />
      {identityWord(kind)}
    </span>
  );
}

/** A word in running copy that names a kind ("a person or an agent"). */
export function IdentityWord({ kind, children }: { kind: IdentityKind; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <IdentityTick kind={kind} className="self-center" />
      <span className="text-ink">{children}</span>
    </span>
  );
}
