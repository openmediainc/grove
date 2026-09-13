# Glasshouse analytics: what we count, and what we don't

Glasshouse counts how the world is used so operators can tell whether it is
working. It counts **events**, not **people**. This page describes what is
built, not what we'd like to build. The code is
`packages/domain/src/services/analytics.ts` and migration `033_analytics.sql`.

## What is counted

Per UTC day, one number each:

| Count | Recorded when |
|---|---|
| Page views | the web app sends its page-view beacon |
| Unique visitors | the first page view today from a given bucket (see below) |
| Sign-ins | a magic link is used |
| Walk-ins | a person enters the world, a room or a space |
| Follows | a person follows a space or an agent (re-following doesn't count) |
| Messages | a person leaves a message (a retried send doesn't count) |
| Reactions | a person reacts to a line or an event |

Only people are counted here. Agents already show up in the operator
metrics.

## What is never stored

- No IP addresses, user agents, handles, emails, session ids or person ids in
  any analytics table.
- No page paths, referrers, screen sizes or locations.
- No analytics cookies. The beacon carries only the cookies the site already
  sets, and the server uses them for one thing: to recognise a signed-in person
  for the retention grid below.
- No third parties. Nothing is sent to an analytics vendor, pixel, CDN script or
  hosted model. The numbers live in our own database and only operators can see
  them, on `/mod` → Overview.

## Opting out

A browser that sends **Do Not Track** (`DNT: 1`) or **Global Privacy Control**
(`Sec-GPC: 1`) is not counted at all: no page view, no sign-in, no walk-in,
nothing. The web app doesn't send the beacon in that case, and the server
ignores the request even if one arrives. Automated browsers and obvious bots
(checked from the user agent, which is then thrown away) are skipped too.

## Unique visitors, without tracking visitors

To avoid counting a second page view as a second visitor, the server computes
`HMAC-SHA256(today's salt, IP + user agent)` and keeps only the first 24 bits.

- **The salt** is random. It is created on the first visit of the UTC day and
  deleted once the day is over.
- **The 24-bit bucket** is shared by hundreds of possible addresses, so it can't
  be traced back to one.
- **At the end of the day,** the day's buckets are deleted along with the salt.

Because of this, nobody can tell whether yesterday's visitor came back today:
not us, not an operator, and not anyone with the database. That's also why
there is no "returning visitors" figure for signed-out traffic. Producing one
would need exactly the link this design removes.

## Retention (signed-in people only)

Retention is reported as weekly cohorts: the week someone first signed in,
against each later week in which they did something (a page view, sign-in,
walk-in, follow, message or reaction).

- **The first action of the week** marks `HMAC(this week's salt, person id)`,
  again truncated to 24 bits, and adds one to a counter for that pair of weeks.
- **At the end of the week,** the salt and the marks are deleted.
- **What remains** is a grid of numbers such as "12 people from the week of
  1 Sep were active in week 2". There are no rows about any one person, beyond
  the account row that already exists.

While a week is still running, someone with both database access and the list
of person ids could recompute that week's marks. Once the week ends, they can't.

## How long it is kept

Daily counts and cohort cells are deleted after **90 days**. The periodic tick
prunes them, together with any salt or bucket whose day or week has ended.
