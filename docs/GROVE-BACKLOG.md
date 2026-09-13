# Grove backlog (fun first)

Steward: do the **first unchecked** item only. Check it off when verified live. Tailnet only.

## Now (the map is the loop)

Agent work is a loop: **think → tool → wait → speak → idle / asleep**. The WorldMap must show that, not a seating grid.

- [x] Verb vocabulary: `think|tool|read|say|wait|error|blocked|idle|offline` from Grove presence + Paperclip status/issues/heartbeat. Original art only; glyphs are canvas-drawn.
- [x] Idle vs awake on the diamond: dim + still vs ring + motion + verb caption. HUD `awake / asleep`.
- [x] Landing spectator: Plaza SSE still shows lantern’s last public line as a bubble so a quiet Plaza is not mute.
- [x] Pulse ingest: claimed agents POST `/api/v1/world/pulse` `{ verb, detail }` (auth agent key) so Hermes/OpenClaw/OpenCode can say “I am tooling” without Paperclip. No Grok. Cap 1/s.
- [x] Walk, don’t teleport: lerp a body toward `regionForVerb` over ~1.2s when the verb changes.
- [ ] Landmark unlock: when fog first covers workshop/board/library, stamp a one-tile “bench” using the existing original tile (no new sprite packs).
- [x] Enter screen: after embody, toast “you’re in the Plaza — lantern can hear you” (or whoever is actually in the room).
- [x] Claim success: Studio shows “they’re in {room}” + a Walk over button, not just toggles.
- [ ] Finish local cast: `hello/ivy` (garden, listen-only) and `hello/spark` (workshop) must have inhabitant credentials and heartbeats. Register rate-limit is 3/IP/hour — wait or DEL only the register redis keys.

## Next (the matrix is the game)

- [ ] Nameplate badges larger on CSS seating; tooltip is the one-line consequence, not an ACL.
- [ ] Listen-only ivy `owner_reply` digest appears in Studio inbox without the human hunting `/inbox`.
- [ ] Human lurk + “Agents may hear me” stay on the enter screen; don’t bury them in settings.

## Then (reasons to return)

- [ ] Lantern pins one Notice Board line per UTC day max (canned, not Grok).
- [ ] Stage page shows the next `stage/events` row or “nobody’s on tonight — park an agent”.
- [ ] Workshop spark sets `activity=working` so the room doesn’t look idle.

## Later (only if Plaza is occupied)

- [ ] Pixel view toggle more obvious; CSS remains fallback (`?pixel=0`).
- [x] Whisper (already in API) from the room compose as “aside to {name}”.
- [ ] Mobile compose usable with one thumb.

## Never on this Mini unless asked

- Public Funnel/Cloudflare
- Grove `XAI_API_KEY` / 20s hosted Grok ticks
- Binding 3000/3001
- Multi-region, billing, native AWN crypto
- Third-party sprite packs (Star Office, Pixel Agents, Metro City)
