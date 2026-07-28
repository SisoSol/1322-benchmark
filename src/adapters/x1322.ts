/**
 * Adapter for the 1322 X/Twitter WebSocket feed.
 *
 * Contract source: https://1322.io/docs (X/Twitter section) as of the date
 * in README.md. Re-verify against the live docs before relying on this for
 * anything beyond the shape below — 1322 can change its payloads.
 *
 * Endpoints (documented):
 *   normal:   wss://ws.normal.1322.io/ws/normal
 *   ultimate: wss://ws.ultimate.1322.io/ws/ultimate
 * Auth: header X-API-Key, header Authorization: Bearer <key>, or query
 *   token=<key>. This adapter uses the header form so the key never ends up
 *   in a URL that might get logged.
 *
 * Event flow for a new tweet (progressive enrichment, each stage carries the
 * same tweet.id and enriches the previous one):
 *   1. tweet.mini.update  - first event for ANY tweet, brief/fast payload.
 *   2. tweet.update       - fuller payload, sent if the tweet needs enrichment
 *                           (quote/reply/retweet/card), ~shortly after (1).
 *   3. tweet.update.expanded - untruncated text / article body, only if needed.
 *   4. tweet.full         - fullchain, entire reply/quote thread resolved.
 * Other event types observed on this stream: tweet.deleted, profile.update,
 * profile.pinned.update, profile.unpinned.update, following.update.
 *
 * Timestamp honesty note (this is the whole point of this file):
 * The documented payload gives you `tweet.created_at` — the timestamp
 * Twitter's own servers assigned to the tweet — inside every tweet.* event.
 * It does NOT give you a separate "1322 detected this at T" timestamp
 * anywhere in the X/Twitter contract (contrast with 1322's Truth Social
 * `seen_at`, Binance Square `detected_at`, or News `_sent_time` fields,
 * which ARE explicit provider-side detection/dispatch timestamps — see
 * README.md's per-platform timestamp table). So for this adapter,
 * providerDetectTsMs is always null: there is nothing to fill it with
 * without inventing a number, and this tool does not invent numbers.
 * The only latency you can honestly compute against this feed is
 * `client_receive_ts_ms - publish_ts_ms`, which bundles together whatever
 * time elapsed between the tweet existing on Twitter's servers and this
 * process receiving the WebSocket frame (upstream detection + delivery +
 * your own network path) — not a clean "server processing time" figure.
 */

import type {
  ConnectionOptions,
  DetectionSample,
  FeedAdapter,
  ResolvedConnection,
} from "./types";

const WS_URL_BY_TIER: Record<string, string> = {
  normal: "wss://ws.normal.1322.io/ws/normal",
  ultimate: "wss://ws.ultimate.1322.io/ws/ultimate",
};

const PRIMARY_SIGHTING_EVENT_TYPE = "tweet.mini.update";

const TWEET_STAGE_EVENT_TYPES = new Set([
  "tweet.mini.update",
  "tweet.update",
  "tweet.update.expanded",
  "tweet.full",
]);

const PUBLISH_TS_SOURCE =
  "x1322:tweet.created_at (Twitter's own tweet-creation timestamp, ms epoch — not a 1322-assigned detection timestamp)";

const PROVIDER_DETECT_TS_SOURCE =
  "not present in the documented 1322 X/Twitter WebSocket payload (no field distinct from tweet.created_at exists on this feed)";

interface TwitterMiniUserLike {
  handle?: string;
}

interface TwitterTweetLike {
  id?: string;
  created_at?: number;
  author?: TwitterMiniUserLike;
}

interface X1322Envelope {
  id?: string;
  type?: string;
  source?: string;
  tweet?: TwitterTweetLike;
}

export class X1322Adapter implements FeedAdapter {
  readonly id = "x1322";
  readonly description =
    "1322 X/Twitter WebSocket feed (wss://ws.normal.1322.io or wss://ws.ultimate.1322.io)";

  resolveConnection(opts: ConnectionOptions): ResolvedConnection {
    const tier = (opts.tier ?? "normal").toLowerCase();
    if (!(tier in WS_URL_BY_TIER)) {
      throw new Error(
        `Unknown --tier "${tier}" for adapter x1322. Valid values: ${Object.keys(
          WS_URL_BY_TIER,
        ).join(", ")}.`,
      );
    }

    if (!opts.apiKey) {
      throw new Error(
        "Missing API key for adapter x1322. Set the X1322_API_KEY environment " +
          "variable (or --api-key) to your 1322 API key for the matching tier " +
          "(a normal-tier key for --tier normal, an ultimate-tier key for " +
          "--tier ultimate). Get one from your 1322 dashboard.",
      );
    }

    const url = opts.wsUrlOverride ?? WS_URL_BY_TIER[tier]!;

    return {
      url,
      headers: {
        "X-API-Key": opts.apiKey,
      },
      authDescription: `X-API-Key header (${tier}-tier key, value redacted)`,
    };
  }

  parseMessage(raw: string, receivedAtMs: number): DetectionSample[] {
    let msg: X1322Envelope;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return [];
      msg = parsed as X1322Envelope;
    } catch {
      // Not JSON (e.g. a bare protocol-level frame). Nothing to sample.
      return [];
    }

    const eventType = msg.type;
    if (!eventType || !TWEET_STAGE_EVENT_TYPES.has(eventType)) {
      // profile.update / profile.pinned.update / profile.unpinned.update /
      // following.update / tweet.deleted / anything unrecognized: not a
      // "new content" detection event this benchmark scores. tweet.deleted
      // is excluded deliberately: its `deleted_at` field's semantics
      // (deletion-detected-at vs. something else) are not documented, and
      // this tool will not guess at a timestamp's meaning.
      return [];
    }

    const tweet = msg.tweet;
    if (!tweet || typeof tweet.id !== "string") return [];

    const eventId = msg.id ?? `${tweet.id}:${eventType}:${receivedAtMs}`;
    const publishTsMs =
      typeof tweet.created_at === "number" ? tweet.created_at : null;

    const sample: DetectionSample = {
      eventId,
      eventType,
      isPrimarySighting: eventType === PRIMARY_SIGHTING_EVENT_TYPE,
      account: tweet.author?.handle ?? null,
      publishTsMs,
      publishTsSource: publishTsMs !== null ? PUBLISH_TS_SOURCE : null,
      providerDetectTsMs: null,
      providerDetectTsSource: PROVIDER_DETECT_TS_SOURCE,
    };

    return [sample];
  }
}
