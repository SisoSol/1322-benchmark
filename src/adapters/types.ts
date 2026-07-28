/**
 * Adapter contract. An adapter's only job is: (1) turn CLI options + an API
 * key into a WebSocket URL/headers to connect to, and (2) turn one raw
 * inbound WebSocket text frame into zero or more DetectionSample rows.
 *
 * The runner (src/run.ts) owns everything else: connecting, reconnect
 * backoff, timing (client_receive_ts_ms is stamped by the runner at the
 * moment the frame is handed to the adapter, not by the adapter itself, so
 * every adapter measures client receipt time identically), output writing,
 * and percentile computation.
 *
 * This separation is what makes the tool usable against a feed it was never
 * specifically written for: implement (or config-drive, see generic.ts) this
 * one interface and everything else — reconnect policy, output schema,
 * percentile math — is shared and unmodified.
 */

export interface ConnectionOptions {
  /** Resolved API key/secret, if the target feed needs one. Never logged. */
  apiKey: string | null;
  /** Adapter-specific tier/variant selector (e.g. 1322 X: "normal" | "ultimate"). */
  tier: string | null;
  /** Explicit WebSocket URL override from --ws-url, if the user supplied one. */
  wsUrlOverride: string | null;
  /** Path to a generic-adapter JSON config file, if --config was supplied. */
  configPath: string | null;
}

export interface ResolvedConnection {
  /** The literal WebSocket URL that will be dialed. */
  url: string;
  /** Extra headers to send on the WS upgrade request (e.g. auth headers). */
  headers?: Record<string, string>;
  /** Human-readable description of how auth was attached, with the key redacted. */
  authDescription: string;
}

export interface DetectionSample {
  /** Stable identifier for this specific event message (dedupe key). */
  eventId: string;
  /** Adapter/protocol-defined event type string, e.g. "tweet.mini.update". */
  eventType: string;
  /** True for the event type this adapter considers the primary "first sighting" signal. */
  isPrimarySighting: boolean;
  /** Best-effort account/handle/channel identifier the event is attributed to. */
  account: string | null;
  /** The source's own "this content was published/created" timestamp, in epoch ms, if present. */
  publishTsMs: number | null;
  /** Human-readable description of exactly which payload field publishTsMs came from. */
  publishTsSource: string | null;
  /**
   * An explicit "the vendor's backend observed/detected this" timestamp distinct
   * from publish time, in epoch ms, ONLY if the payload actually documents and
   * carries one. Adapters must leave this null (with a clear source note
   * explaining why) rather than guess or substitute another field.
   */
  providerDetectTsMs: number | null;
  providerDetectTsSource: string | null;
}

export interface FeedAdapter {
  readonly id: string;
  readonly description: string;

  /** Build the WebSocket URL/headers to connect with, or throw a clear Error. */
  resolveConnection(opts: ConnectionOptions): ResolvedConnection;

  /**
   * Parse one raw WebSocket text frame. Return an empty array for frames
   * that carry no benchmarkable content event (heartbeats, acks, profile
   * events, control messages, etc). Must never throw on malformed/unexpected
   * JSON — catch and return [] so one bad frame can't crash a long run.
   */
  parseMessage(raw: string, receivedAtMs: number): DetectionSample[];
}
