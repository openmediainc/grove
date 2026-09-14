/**
 * Compile-time tests for the theme contract. Never imported; `pnpm -r
 * typecheck` is the test runner. Each `@ts-expect-error` below FAILS the build
 * if the line after it stops being an error — i.e. if the contract ever starts
 * letting a theme leave a slot out.
 */

import { aoe, DECOR_STYLE as AOE_DECOR_STYLE, ROOM_STYLE as AOE_ROOM_STYLE } from "./aoe";
import type { DecorStyle } from "./decor";
import type { RoomStyle } from "./room";
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

// A theme that forgets the pixel room (#58) does not compile.
const { room: _room, ...artWithoutRoom } = aoe.art;
// @ts-expect-error — missing ThemeArt.room
export const missingRoomSlot: ThemeArt = artWithoutRoom;

// A room style without its lamp light does not compile.
const { lampLight: _lampLight, ...roomStyleWithoutLamp } = AOE_ROOM_STYLE;
// @ts-expect-error — missing RoomStyle.lampLight
export const missingRoomMaterial: RoomStyle = roomStyleWithoutLamp;

// The room slot takes only the five pieces.
// @ts-expect-error — "throne" is not a RoomPiece
export const unknownRoomPiece = (ctx: CanvasRenderingContext2D) => aoe.art.room(ctx, "throne", 0, 0, 64, 64);

// A room style must name one of the four materials.
// @ts-expect-error — "marble" is not a RoomStyle material
export const unknownRoomMaterial: RoomStyle = { ...AOE_ROOM_STYLE, material: "marble" };

void _room;
void _lampLight;
void _decor;
void _water;
void _scaffold;
void _board;
void _private;
