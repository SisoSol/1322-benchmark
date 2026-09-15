# 1322-benchmark

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![CI](https://github.com/SisoSol/1322-benchmark/actions/workflows/ci.yml/badge.svg)
![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

A vendor-neutral command-line tool for measuring real-time social feed latency: how long a WebSocket feed takes to deliver a new post after it is published, measured the same way for every feed. It ships a working adapter for 1322's X/Twitter feed and a config-driven adapter for any WebSocket endpoint that sends one JSON object per frame, so you can run it against 1322, a competitor you already have a key for, or your own infrastructure. Maintained by the 1322 team; this repository contains no latency ranking or claimed result, only the runner, the methodology and the output schema.

## What this is not

This repository does not contain a latency ranking, a leaderboard, or
any claimed benchmark result for 1322 or any other vendor. There is no
"our numbers" here — only a runner, a methodology, and an output
schema. If you want a number, run it yourself against your own account
and your own region, and it'll write one to a file.

This is deliberate, not an oversight. We (the people behind 1322) spent
time looking at how real-time social-monitoring vendors talk about
speed — ourselves included — and concluded that a single-account
screenshot or a cross-vendor ranking assembled from numbers that were
never measured the same way isn't evidence, it's marketing with extra
steps. So instead of publishing a number, we're publishing the tool
that would let you (or anyone) produce one honestly, plus the exact
checklist we think a fair test has to satisfy. See
[Methodology](#methodology) below.

## Contents

- [Why a runner and not a result](#what-this-is-not)
- [Methodology](#methodology)
- [Per-platform timestamp availability](#per-platform-timestamp-availability-1322-specific)
- [Install](#install)
- [Quickstart: running against 1322](#quickstart-running-against-1322)
- [CLI reference](#cli-reference)
- [Output schema](#output-schema)
- [Running against another provider](#running-against-another-provider)
- [Reconnect and outlier policy](#reconnect-and-outlier-policy)
- [Known sources of error](#known-sources-of-error-read-this-before-you-cite-a-number)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [Related](#related)
- [License](#license)

## Methodology

A latency number without a method attached is not useful, and a
ranking built from numbers that were each measured a different way is
actively misleading. Any run of this tool — against 1322 or anything
else — should be reported alongside all of the following, which this
tool's output format was built around:

| # | What a fair report needs | Where this tool puts it |
|---|---|---|
| 1 | The publication timestamp source (what "published" means for this feed) | `publish_ts_source` — a human-readable description of exactly which payload field was used, per row |
| 2 | The provider's own receipt/detection timestamp, if the feed exposes one | `provider_detect_ts_ms` / `provider_detect_ts_source` — `null` with an explanation when the feed doesn't expose one, never guessed |
| 3 | The client receipt timestamp, if measuring end to end | `client_receive_ts_ms` — stamped by the runner at the moment the WebSocket frame is handed off, identically for every adapter |
| 4 | Test region and network path | `--region <label>` (required flag) — this tool cannot reliably auto-detect where it's running or what path traffic takes, so it asks instead of guessing |
| 5 | Monitored accounts | `monitored_account` per row, plus a de-duplicated list in the run summary |
| 6 | Sample count and test window | `--samples` / `--duration` stop conditions, `sample_index`, and elapsed time in the summary |
| 7 | p50, p90, and p99 | Printed in the run summary and computable yourself from the raw file (`min`/`mean`/`stddev` are included too) |
| 8 | Reconnect and outlier policy | Documented and enforced identically for every run — see [Reconnect and outlier policy](#reconnect-and-outlier-policy) |
| 9 | Whether the result is server detection or final user delivery | Documented per adapter (see [Per-platform timestamp availability](#per-platform-timestamp-availability-1322-specific)) — this tool measures **frame arrival at this process**, not rendering, not delivery to a phone, not a Discord/Telegram hop downstream of the feed |

If a result — yours, ours, or anyone else's — doesn't answer all nine
of these, treat it as a demo, not a benchmark.

## Per-platform timestamp availability (1322-specific)

This matters enough to spell out before anyone runs the tool: **not
every feed exposes an explicit "the vendor detected this" timestamp**,
and this tool will not invent one where the payload doesn't provide
it. Cross-checked against 1322's own published API docs
(`/docs`) at the time this was written:

| 1322 feed | Publish timestamp field | Explicit provider-detection timestamp? |
|---|---|---|
| X / Twitter | `tweet.created_at` (Twitter's own creation time) | **No.** Not present anywhere in the documented WebSocket contract. The `x1322` adapter always leaves `provider_detect_ts_ms` null and says why. |
| Truth Social | `timestamp` | **Yes** — `seen_at`, documented as the timestamp 1322 first detected the post. |
| Instagram | `timestamp` | The payload carries a `seen_at` field, but the current docs page doesn't include an explicit field-note defining its semantics the way it does for Truth Social. Verify against a live message before trusting it. |
| Binance Square | `published_at` | **Yes** — `detected_at`, documented as the timestamp 1322 first detected the post. |
| News | `publish_time` | Carries `_sent_time`, documented as a *dispatch* timestamp ("when 1322 dispatched the article") — adjacent to, but not documented as identical to, a detection timestamp. |
| YouTube | Not present | The documented upload/upgrade/deletion payloads carry no timestamp field of any kind. |

This repository only ships a coded adapter for X/Twitter (see
[What this is not](#what-this-is-not) for why we didn't build and run
the others ourselves). The table above exists so that if you use the
[generic adapter](#running-against-another-provider) against one of
1322's other feeds — or against a different vendor entirely — you go
in knowing which timestamps are real and which are absent, instead of
finding out the hard way.

## Install

Requires Node.js 18 or newer.

```bash
git clone https://github.com/SisoSol/1322-benchmark.git
cd 1322-benchmark
npm install
npm run build
```

This gives you `dist/cli.js`. Run it directly with `node dist/cli.js`,
or install it onto your `PATH`:

```bash
npm link
1322-benchmark --help
```

## Quickstart: running against 1322

1. Get an X/Twitter API key from your [1322](https://1322.io) dashboard
   (normal-tier or ultimate-tier, matching the `--tier` you'll use),
   and make sure the accounts you want to measure are already on your
   tracked list (add them via the dashboard or the `POST /v1/tracked`
   management API — this tool only reads the stream, it doesn't manage
   your tracked-account list).
2. Set the key as an environment variable rather than passing it on
   the command line:

   ```bash
   export X1322_API_KEY=your_real_key_here
   ```

3. Run it:

   ```bash
   1322-benchmark run \
     --region us-east-1-home-fiber \
     --tier normal \
     --samples 200 \
     --out x1322-normal-run.jsonl
   ```

   `--region` is free text you choose — this tool has no reliable way
   to detect your real network position, so it asks instead of
   guessing (see checklist item 4 above). Use something specific
   enough that a reader could reproduce your vantage point, e.g.
   `eu-west-hetzner-fsn1` or `home-comcast-us-midwest`.

4. Let it run until it hits `--samples` (or use `--duration <seconds>`
   instead, or just leave both at their default of unlimited and stop
   it yourself with Ctrl-C — either way you get a full summary and a
   flushed output file).

The run prints a summary to stdout when it stops (by sample count,
duration, Ctrl-C, or giving up after too many failed reconnects) and
writes one row per tweet-detection event to `--out` in JSONL (default)
or CSV.

## CLI reference

```
1322-benchmark run [options]

Required:
  --region <label>       Free-text test-region/vantage-point label.

Adapter selection:
  --adapter <id>         x1322 (default) | generic
  --tier <tier>          x1322 only: normal (default) | ultimate
  --api-key <key>        Falls back to $X1322_API_KEY, then $API_KEY.
                          Prefer the environment variable over this flag.
  --ws-url <url>         Override the adapter's default WebSocket URL.
  --config <path>        Required for --adapter generic. See
                          examples/generic-adapter.example.json.

Stop conditions:
  --samples <n>          Stop after N primary-sighting samples. 0 = unlimited.
  --duration <seconds>   Stop after N seconds. 0 = unlimited.
                          (Ctrl-C always stops cleanly and prints a summary.)

Output:
  --out <path>           Defaults to ./benchmark-<timestamp>.<format>.
  --format <format>      jsonl (default) | csv
  --all-events           Include progressive-stage events (tweet.update,
                          tweet.full, ...) in the printed summary stats too,
                          not just the primary tweet.mini.update sighting.
                          Every event type is always written to the output
                          file regardless of this flag.

Reliability:
  --max-reconnects <n>   Give up after N consecutive failed reconnects
                          (default 5), instead of retrying forever.
  --quiet                Suppress stderr progress logging.

  -h, --help              Per-command help
  -V, --version           Print the installed version
```

Run `1322-benchmark --help` or `1322-benchmark run --help` for the
authoritative, always-current listing.

## Output schema

One row per recorded event. This is the real column set — every field
below is emitted by the code, not aspirational.

| Column | Meaning |
|---|---|
| `schema_version` | Output format version, for downstream parsers. |
| `run_id` | UUID generated once per invocation. |
| `adapter` / `tier` | Which adapter (and, for x1322, which tier) produced this row. |
| `test_region` | The `--region` value for this run. |
| `sample_index` | 1-based order within this run. |
| `received_at_iso` | `client_receive_ts_ms` as an ISO-8601 string, for readability. |
| `event_id` | Adapter-assigned unique id for this event (dedupe key). |
| `event_type` | Adapter/protocol event type, e.g. `tweet.mini.update`. |
| `is_primary_sighting` | Whether this adapter treats this event type as the primary "first sighting" signal. |
| `monitored_account` | Best-effort account/handle attribution. |
| `publish_ts_source` / `publish_ts_ms` | Where the publish timestamp came from, and its value in epoch ms (`null` if absent). |
| `provider_detect_ts_source` / `provider_detect_ts_ms` | Same, for an explicit provider-detection timestamp — `null` (with a reason) when the feed doesn't expose one. Never fabricated. |
| `client_receive_ts_ms` | Epoch ms when this process received the WebSocket frame. |
| `publish_to_client_delta_ms` | `client_receive_ts_ms - publish_ts_ms`, or `null` if either side is missing. |
| `provider_detect_to_client_delta_ms` | `client_receive_ts_ms - provider_detect_ts_ms`, or `null` if either side is missing. |

Illustrative structure only — no measured values, per the constraint
this whole project is built around:

```jsonc
{
  "schema_version": 1,
  "run_id": "<uuid>",
  "adapter": "x1322",
  "tier": "normal",
  "test_region": "<your --region value>",
  "sample_index": "<integer>",
  "received_at_iso": "<ISO-8601 timestamp>",
  "event_id": "<string>",
  "event_type": "tweet.mini.update",
  "is_primary_sighting": true,
  "monitored_account": "<handle or null>",
  "publish_ts_source": "x1322:tweet.created_at (...)",
  "publish_ts_ms": "<epoch-ms integer or null>",
  "provider_detect_ts_source": "<string explaining availability>",
  "provider_detect_ts_ms": null,
  "client_receive_ts_ms": "<epoch-ms integer>",
  "publish_to_client_delta_ms": "<integer or null — NOT a claimed result>",
  "provider_detect_to_client_delta_ms": null
}
```

The run summary printed to stdout follows the same rule: it shows
`count`, `min`, `p50`, `p90`, `p95`, `p99`, `max`, `mean`, and `stddev`
computed from whatever a given run actually recorded — there is no
pre-filled or example numeric summary anywhere in this repository.

## Running against another provider

The `generic` adapter connects to any WebSocket URL and parses any
feed that sends one JSON object per text frame, driven entirely by a
JSON config — no code changes required. See
[`examples/generic-adapter.example.json`](examples/generic-adapter.example.json)
for an annotated example (it documents field paths from a real,
published 1322 API contract for a *different* 1322 feed than the one
this tool connects to by default, purely to show the config shape —
this repository does not execute it or connect to that feed).

Config shape:

```jsonc
{
  "name": "my-feed",
  "wsUrl": "wss://example.com/stream?key={API_KEY}",
  "headers": { "Authorization": "Bearer {API_KEY}" },
  "fields": {
    "type": "type",                                   // dot-path, optional
    "id": "data.id",                                   // dot-path, required
    "account": "data.author",                           // dot-path, optional
    "publishedAt": { "path": "data.created_at", "format": "iso8601" },
    "providerDetectedAt": { "path": "data.seen_at", "format": "iso8601" }
  },
  "contentEventTypes": ["post.created"],
  "primaryEventTypes": ["post.created"]
}
```

`{API_KEY}` in `wsUrl`, `headers`, or `queryParams` is substituted with
whatever `--api-key` / `$API_KEY` resolves to. `format` is one of
`epoch_ms`, `epoch_s`, or `iso8601`.

```bash
1322-benchmark run --adapter generic --config ./my-feed.json \
  --region eu-west-hetzner-fsn1 --samples 200 --out my-feed-run.jsonl
```

**We deliberately did not run this tool against any vendor other than
1322 as part of building this repository** — we don't hold API keys
for other providers, and connecting to a third party's live service
without their knowledge isn't something we're going to do just to
populate a comparison. If you already have a legitimate key for
another feed, we'd genuinely like to see what you find: run it, keep
both the raw output file and the exact config you used, and publish
your own results with your own name on them. That's a real,
independently-produced data point in a way that anything we published
about a service we don't operate never would be.

## Reconnect and outlier policy

Matches 1322's own documented WebSocket reconnection guidance, and is
identical across every adapter so it can't quietly bias one run
relative to another:

- On disconnect, reconnect with exponential backoff: 1s, 2s, 4s, 8s,
  16s, capped at 30s.
- No events are queued server-side during a disconnect — a dropped
  connection means missed events for that window, not delayed ones.
  This tool does not paper over that: a gap in `sample_index` /
  `received_at_iso` in the output file is a real gap, not a bug.
- After `--max-reconnects` consecutive failed attempts (default 5),
  the process exits non-zero with a clear message instead of retrying
  forever — a deliberate CLI-specific limit, not part of 1322's
  production reconnect policy, added so an automated or CI run can't
  hang indefinitely on a misconfigured endpoint.
- Outliers are **not** automatically dropped from the stats or the
  output file. `min`/`max`/`stddev` are printed alongside the
  percentiles specifically so a slow tail is visible rather than
  quietly trimmed. If you want to exclude something (e.g. a sample
  that straddled a reconnect), do it explicitly and say so.

## Known sources of error (read this before you cite a number)

- **Clock skew.** `publish_to_client_delta_ms` is `client_receive_ts_ms`
  (this machine's clock) minus a timestamp set by a remote server
  (Twitter's, or another vendor's). Any skew between that server's
  clock and yours lands directly in the number, indistinguishable from
  real network/processing time. Run this on a host with NTP time sync
  and say so in your write-up.
- **Single vantage point.** One run from one machine tells you about
  that machine's network path, not "the internet." Comparing two
  providers fairly means running both from the same host, at
  overlapping times, ideally against overlapping accounts.
- **`publish_ts` is not always a detection timestamp.** See
  [Per-platform timestamp availability](#per-platform-timestamp-availability-1322-specific).
  For X/Twitter specifically, `publish_to_client_delta_ms` bundles
  together upstream detection time, delivery time, and your own
  network path — it is not a clean "server processing time" figure,
  and this README is not going to pretend otherwise.
- **Progressive enrichment.** 1322's X/Twitter feed sends a tweet
  across multiple stages (`tweet.mini.update` first, then
  `tweet.update` / `tweet.update.expanded` / `tweet.full` as
  enrichment becomes available). The `x1322` adapter treats only
  `tweet.mini.update` as the primary "first sighting" signal for
  headline stats by default, because it's documented as the fastest,
  first event for any tweet — later stages measure enrichment latency,
  not detection latency. Pass `--all-events` if you want those in the
  printed summary too, but don't average them together with
  first-sighting numbers without saying so.
- **Low sample counts.** p99 on 10 samples is not a percentile, it's
  the second-slowest sample you happened to catch. The methodology
  table asks for a stated sample count for a reason — report it next
  to every percentile you cite.

## Architecture

```
src/
  cli.ts              Argument parsing (commander) only.
  run.ts              Connect, reconnect, timestamp, write rows, print summary.
  stats.ts            Percentiles / summary stats over real recorded values.
  output.ts           Output row schema + JSONL/CSV writers.
  adapters/
    types.ts           FeedAdapter contract every adapter implements.
    x1322.ts            1322 X/Twitter adapter (coded, ships with this repo).
    generic.ts          Config-driven adapter for any JSON-over-WebSocket feed.
    registry.ts         Adapter lookup by --adapter id.
```

An adapter's entire job is two functions: turn a key/config into a
WebSocket URL to connect to, and turn one raw text frame into zero or
more samples. Everything else — connecting, reconnect backoff,
`client_receive_ts_ms` stamping, output writing, percentile math — is
shared runner code, identical no matter which feed you point it at.
That's what makes an apples-to-apples comparison between two adapters
meaningful instead of an artifact of two different measurement
codepaths.

To add a coded adapter for a feed the generic config can't express
cleanly, implement `FeedAdapter` (see `src/adapters/types.ts`) and
register it in `src/adapters/registry.ts`. PRs welcome — see
[Contributing](#contributing).

## Contributing

Issues and PRs are welcome, especially:

- Adapters (coded or example configs) for other real-time feeds.
- Corrections to the [per-platform timestamp table](#per-platform-timestamp-availability-1322-specific)
  if a provider's documented payload has changed.
- Sharper wording on the methodology checklist or the sources-of-error
  section, if you've found a way this tool's output could still
  mislead someone.

What won't be merged: anything that adds a hardcoded or example
latency figure, for any vendor, anywhere in this repository — including
in code comments, sample output, or documentation. That's the one rule
this project doesn't bend on.

Before opening a PR: `npm run typecheck && npm run lint && npm run build`.
CI runs the same checks (plus `--help` smoke tests) on Node 18 and 22.

## Related

- [1322-signal-observatory](https://github.com/SisoSol/1322-signal-observatory) - the operating profiles 1322 publishes, which this tool lets you check
- [1322-client](https://github.com/SisoSol/1322-client) - TypeScript/JavaScript client for the 1322 feeds

## License

[MIT](LICENSE)
