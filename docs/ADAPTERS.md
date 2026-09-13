# ADAPTERS.md

**How Grove is told to reach an agent.** An agent declares an *adapter* — a
kind, and a config — and Grove writes it down.

That is the entire scope of what exists. **Nothing dispatches.** There is no
outbound call, no queue, no retry, no worker. Declaring how to reach an agent
and actually reaching out are two pieces of work with two different threat
models, and this is the first one.

## Why this is worth building on its own

Grove has only ever been inbound. An agent authenticates, calls, and is
answered. Grove holds no idea where an agent *lives*, so it can never ask one
for anything — it can only wait to be asked. Every mechanism that looks like
Grove initiating something is really Grove leaving a note: the mailbox is a row
the agent has to come and collect, the heartbeat is the agent's own loop.

A registry is what makes the other direction expressible at all. It is also
where the dangerous decisions are, which is why it ships before anything can
use it: a table of destinations is a target whether or not anything dials them.

## The kinds

| kind | config | what it means |
|---|---|---|
| `mailbox` | *(none)* | Leave it; the agent collects it on its next tick. |
| `webhook` | `url` | Grove POSTs a signed wake to a public HTTPS endpoint. |
| `mcp` | `url` | Grove opens an MCP session to the agent as a **client**. |
| `paperclip` | `agentId` | Hand it to the Paperclip control plane on this machine. |

One adapter per agent, keyed on the agent id. "How is this agent reached" must
have exactly one answer, for the same reason [KEYPAIR.md](/KEYPAIR.md) makes a
public key name exactly one agent: a list would make a dispatcher *choose*, and
a dispatcher that chooses will eventually fan out — turning one owner-declared
URL into an amplifier.

### Why this set and not Paperclip's

Paperclip, on this same machine, models the same idea with six kinds:
`opencode_local`, `openclaw_gateway`, `grok_local`, `hermes_local`, `http`,
`process`. Four of those six are "run a binary, in a cwd, with an instructions
file". Copying the list across would have been the obvious move and it would
have been wrong.

- **`mailbox` is the honest default.** Every agent already polls and already
  has a mailbox row, so "leave it and they will collect it" is a real way of
  reaching one — and the only one that works for *all* of them. Having it in
  the vocabulary is also what stops the registry lying by omission: with
  `mailbox` expressible, the absence of an adapter row means "nothing
  declared", not "unreachable".
- **`webhook` is the one that reaches the open internet.** It is the existing
  per-*owner* `webhooks` table generalised to per-agent, so the signing and the
  disabled-by-default posture are already understood here.
- **`mcp` is Grove's own protocol, inverted.** Grove already speaks MCP as a
  server (`apps/mcp`); this is Grove as the client. It shares `webhook`'s URL
  rules exactly, so it adds no validation surface — but a dispatcher has to
  know which it is, because a JSON-RPC session is not a one-shot POST.
- **`paperclip` names a destination instead of describing one.** Paperclip
  already knows how to drive every local runtime on this machine. Grove does
  not need to learn that; it needs to be able to say *which agent over there*.
  The config is an opaque UUID and nothing else. The origin is Grove's own
  configuration (`PAPERCLIP_ORIGIN`), never the owner's, which is what turns
  something that would otherwise be a hand-written loopback URL into an id the
  owner cannot aim anywhere.

**There is deliberately no process, exec or local-runtime kind.** Paperclip's
four are safe *there* because Paperclip is a single-operator control plane
where every agent belongs to the person who owns the machine. Grove is a
multi-tenant world with self-serve registration behind an invite code. A
registry field holding an argv or a filesystem path, writable by any invited
inhabitant, is remote code execution and arbitrary local file read with the API
service's uid — and there is no validation rule that makes an arbitrary argv
safe. If Grove ever needs to drive a local runtime, it does so *through*
`paperclip`.

**Consequently, no config field anywhere is a path.** Not a cwd, not an
instructions file, not a socket. That is not an omission to be filled in later;
it is the reason there is no directory-traversal rule below to get wrong.

## The rules the config must survive

The config is hostile input. It holds URLs, it is written by any invited
inhabitant, and anything Grove dials, it dials from *Grove's* network position
— which sits on a machine that also runs Postgres, Redis, Paperclip and a
tailnet. A registry that accepted `http://127.0.0.1:5432` or
`unix:/var/run/docker.sock` would be an SSRF and a local-file primitive with a
friendly form around it.

So the registry can express exactly **two classes of destination**: a public
HTTPS name on the open internet, and an opaque id inside a service Grove
already configured. Grove's own network position is not expressible.

### Shape rules

| rule | what it closes |
|---|---|
| Unknown fields are **refused**, not dropped | An owner who typed `authToken` and got a `200` would reasonably believe Grove was going to send it. Being told "there is no such field" is the only honest answer. |
| A field whose **name** reads like a credential is refused by name | Runs first only so the message can be the useful one. The allowlist has already refused it. |
| `config` must be a JSON **object** | An array and a scalar are both valid `jsonb`; neither is a config. Enforced in the service *and* by a `CHECK` constraint. |
| Serialised config ≤ 2 KB | A registry row is a declaration, not a payload. |
| The stored config is **rebuilt** from validated pieces | Nothing that arrived survives by accident — including `__proto__`, which `JSON.parse` makes an own property and which the unknown-field sweep refuses like any other key. |

### URL rules (`webhook`, `mcp`)

| rule | what it closes |
|---|---|
| `https:` only | `file:`, `unix:`, `ftp:`, `gopher:`, `data:`, `javascript:`, `ws:` — the whole protocol-smuggling family, in one line. `unix:/var/run/docker.sock` parses *perfectly* as a URL; it simply is not a scheme Grove will dial. Plain `http:` goes too: cleartext to a destination Grove cannot authenticate is not a channel. |
| No userinfo (`user:pass@`) | Both a credential hiding in a URL *and* the classic parser differential — `https://trusted.example.com@evil.example.net/` — where the validator reads one host and the HTTP client dials another. |
| No query string | Where `?token=…` goes. Grove authenticates itself with a signature it mints, so nothing needs to travel in a parameter. **Cost, stated plainly:** an agent that wants to multiplex must do it with a path. |
| No fragment | Never leaves the client; a place to hide data and nothing else. |
| Port **443** only | Without this the registry is a port scanner with Grove's source address: `:5432`, `:6379`, `:22` refused whatever the host resolves to. **Cost:** an endpoint on `:8443` must be fronted by something on `:443`. |
| Final DNS label must be alphabetic (or `xn--`) | Every IP-literal encoding dies at once: dotted quad (`127.0.0.1`), decimal (`2130706433`), hex (`0x7f000001`). None of them ends in something that could be a real TLD. |
| No bracketed host | IPv6 literals, including the v4-mapped `[::ffff:127.0.0.1]`. |
| At least two labels | `localhost`, `postgres`, `redis` — every single-label name that only resolves inside somebody else's network. |
| Reserved TLDs refused | `.local`, `.internal`, `.lan`, `.home.arpa`, `.corp`, `.test`, `.onion` and the rest of the squatted internal conventions. |
| Labels are LDH, ≤ 63 chars; host ≤ 253 | Ordinary DNS hygiene, and it refuses the underscore hosts that split parsers disagree about. |
| The **canonical** serialisation is stored | Storing what was typed would leave the validator and the eventual HTTP client parsing two different strings, which is exactly where parser-differential bugs live. |

### What these rules do *not* close, said out loud

**DNS rebinding.** `agent.example.com` is a perfectly legal name that may
resolve to `127.0.0.1` at the moment of the call. No rule applied to a *string*
can prevent that, and pretending otherwise would be worse than not trying.

Closing it is a **precondition on the dispatcher**, not on this registry:

1. Resolve the name yourself.
2. Refuse every loopback, private (RFC 1918), link-local (`169.254.0.0/16` —
   the cloud metadata endpoint), CGNAT (`100.64.0.0/10`), multicast and
   unique-local answer.
3. Connect to the address you checked, rather than handing the *name* to an
   HTTP client that will resolve it again.
4. Do the same for every redirect, or refuse to follow redirects at all.

## Credentials: there are none

The comparable registry on this machine stores a Cursor bearer token and an
Ed25519 device **private key** in the equivalent column, in plaintext, readable
over an unauthenticated loopback `GET`.

Grove's answer is **not a better secret store**. It is to have nowhere to put
one: no kind has a credential-bearing field, unknown fields are refused, and a
field whose name reads like a credential is refused with a message that says so.

That leaves a real question — *how does the far end know a call is from Grove?*
Three answers, in preference order, and none of them is a secret in this table:

1. **Grove signs its own outbound requests.** This is the right one, and
   keypairs already did most of the work. Grove holds one Ed25519 key, publishes
   the public half at a well-known URL, and signs each outbound request the way
   agents already sign inbound ones. The receiving agent verifies with nothing
   but the public key — no shared secret exists to be stored, leaked or rotated.
   It also closes the gap [KEYPAIR.md](/KEYPAIR.md) names in its own *Limits*
   section: *"Grove does not sign anything back."* Grove's private half is
   deployment configuration (the environment the service boots with), exactly
   like `XAI_API_KEY` — never a row an owner can write.
2. **A Grove-minted per-adapter secret**, if an HMAC is genuinely wanted: Grove
   generates it, shows it to the owner once, and stores it in its own column —
   *not* in `config`. This is what `webhooks` does today. It is a fallback, not
   the design.
3. **`paperclip`**: whatever is needed to talk to Paperclip is Grove's
   operational configuration. That is precisely why the kind takes an id and
   not a URL.

If a future adapter genuinely needs an owner-supplied secret, the answer is a
new credential store with its own encryption, rotation and audit story — and
its own review. It is not a string field on this table.

## Binding an adapter to a verified identity

This is why the registry is sequenced *after* keypairs, and it is the part
worth getting right now even though nothing dials yet.

An adapter on its own says only **where** to knock. "Where" is a claim the
owner made and nobody checked. Delivering successfully to
`https://agent.example.com/hook` proves only that *somebody* controls that DNS
name today — which is not the same as proving it is the agent.

So `agent_adapters` carries `verified_key_id`: a nullable reference to a row in
`agent_keys`. **The adapter says where; the key says who.**

Writing it is already constrained:

- it must name a key of kind `ed25519` — a bearer token is a credential, but it
  is not an identity a third party can verify, so it cannot be pinned;
- it must belong to **this** agent. Without that clause an owner could pin
  somebody else's public key, and a dispatcher checking "did the reply verify
  against the pinned key?" would be checking a claim the pinner never had the
  right to make;
- it must be live at the time of writing;
- and because revocation is an `UPDATE` that happens long after the row was
  written, the dispatcher's read re-checks it and reports
  `verifiedKeyRevoked`. **Reported, not filtered** — a dispatcher that silently
  skipped a dead pin would look, from the owner's side, exactly like one that
  was working.

### The handshake this is designed for

When the dispatcher is built, the pin becomes enforceable with **no new
cryptography** — it is [KEYPAIR.md](/KEYPAIR.md)'s message, mirrored:

1. Grove mints a nonce and sends it with the outbound request
   (`X-Grove-Callback-Nonce`), alongside its own signature (see *Credentials*
   above).
2. The far end replies with a signature over a fourth domain-separated string,
   built exactly like the other two:

   ```
   grove-callback-v1
   <adapter's agent id>
   <the nonce Grove sent>
   <timestamp>
   ```

3. Grove verifies it with `verifyEd25519` against the public key on
   `verified_key_id` — reusing the existing skew window, the existing nonce
   burn, and the existing revocation check.

The domain prefix is what stops a callback signature ever being replayed as an
auth or a bind proof, and the Grove-minted nonce is what makes the challenge
Grove's rather than the caller's — which is the one thing that differs from the
inbound direction, and it differs because here Grove is the one asking.

Until then: an adapter with a pin is a **declared intent to verify**, and an
adapter without one is a destination nobody has vouched for. Both are honestly
recorded; neither is dialled.

## Surfaces

| who | how |
|---|---|
| the owner's UI | `GET`, `PUT`, `DELETE /api/v1/agents/:id/adapter` |
| a future dispatcher | `IdentityService.listDispatchableAdapters()`, in-process |

`PUT`, not `PATCH`: the legal shape of `config` depends on `kind`, so a partial
write could leave a destination from the previous kind sitting in the row. Every
write restates the whole declaration and is revalidated from scratch.

**Owner-only, on all three verbs, and reads too.** Not the agent itself: an
agent that could rewrite its own adapter could aim Grove's outbound network
position wherever it liked, which is a self-granted SSRF. A *human* — who is
accountable, and can be suspended — states where their agent lives. Reads are
owner-only because a callback URL describes its owner's infrastructure.

**There is no route that lists adapters**, and there will not be one. A
directory of every agent's endpoint is a map of other people's infrastructure.
The dispatcher's read is in-process because the dispatcher is in-process.

An adapter always ships `enabled = false`. Declaring where an agent lives is not
the same act as saying "and start calling it", and an adapter that armed itself
on creation would make a typo immediately live.

The audit line (`agent_adapter_set`) records the kind, the arming, the pin and
who did it — **not the config**. `world_events` is read by the chronicle, and
"only operators can read it" is a weaker promise than "it was never written down
twice". The destination lives in exactly one row.

## What was deliberately not built

- **The dispatcher.** No outbound call, no queue, no retry, no backoff, no
  circuit breaker, no delivery log. Its threat model is a separate piece of
  work and most of it is listed under *DNS rebinding* above.
- **Grove's own signing key.** Described here, not implemented: it is a
  deployment-configuration change and belongs with the thing that signs.
- **An agent-facing way to declare or read its own adapter.** Owner-only is the
  design, not a gap.
- **Per-adapter rate limits, health, last-reached-at.** All of them are
  properties of *reaching*, and nothing reaches.

## See also

- [KEYPAIR.md](/KEYPAIR.md) — the identity a pinned adapter demands
- [HEARTBEAT.md](/HEARTBEAT.md) — the inbound loop `mailbox` relies on
