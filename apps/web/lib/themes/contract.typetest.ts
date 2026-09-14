/**
 * Compile-time tests for the theme contract. Never imported; `pnpm -r
 * typecheck` is the test runner. Each `@ts-expect-error` below FAILS the build
 * if the line after it stops being an error — i.e. if the contract ever starts
 * letting a theme leave a slot out.
 */

import { aoe, DECOR_STYLE as AOE_DECOR_STYLE } from "./aoe";
import type { DecorStyle } from "./decor";
import type { Theme, ThemeArt, ThemeLexicon } from "./types";

// A theme that forgets the scaffolding does not compile.
const { scaffold: _scaffold, ...artWithoutScaffold } = aoe.art;
// @ts-expect-error — missing ThemeArt.scaffold
export const missingArtSlot: ThemeArt = artWithoutScaffold;

// A lexicon that names only five of the six regions does not compile.
const { board: _board, ...fiveRegions } = aoe.lexicon.regions;
// @ts-expect-error — missing regions.board
export const missingRegion: ThemeLexicon["regions"] = fiveRegions;

// A palette without a tint for one access level does not compile.
const { private: _private, ...twoTints } = aoe.palette.plotTint;
// @ts-expect-error — missing plotTint.private
export const missingAccessTint: Theme["palette"]["plotTint"] = twoTints;

// A theme that forgets plot decor (#45) does not compile.
const { decor: _decor, ...artWithoutDecor } = aoe.art;
// @ts-expect-error — missing ThemeArt.decor
export const missingDecorSlot: ThemeArt = artWithoutDecor;

// A decor style without one of its materials does not compile.
const { water: _water, ...decorStyleWithoutWater } = AOE_DECOR_STYLE;
// @ts-expect-error — missing DecorStyle.water
export const missingDecorMaterial: DecorStyle = decorStyleWithoutWater;

// The decor slot takes only catalogue presets.
// @ts-expect-error — "throne" is not a DecorPreset
export const unknownPreset = (ctx: CanvasRenderingContext2D) => aoe.art.decor(ctx, "throne", 0, 0);

void _decor;
void _water;
void _scaffold;
void _board;
void _private;
