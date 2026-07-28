/**
 * Config-driven adapter for ANY WebSocket feed that pushes one JSON object
 * per text frame. This is what makes the tool vendor-neutral: point it at a
 * different provider by writing a small JSON config instead of writing code.
 *
 * See examples/generic-adapter.example.json for an annotated example, and
 * README.md's "Running against another provider" section for the field
 * reference. That example config is illustrative only — it documents field
 * paths from a real, published 1322 API contract (Binance Square) as a
 * concrete demonstration of the config shape, but this repository does not
 * connect to it or any other third-party/non-X 1322 feed. Nothing in this
 * file talks to the network on its own; it only parses frames handed to it
 * by the runner.
 */

import { readFileSync } from "node:fs";
import type {
  ConnectionOptions,
  DetectionSample,
  FeedAdapter,
  ResolvedConnection,
} from "./types";

export type TimestampFormat = "epoch_ms" | "epoch_s" | "iso8601";

export interface TimestampFieldConfig {
  /** Dot-path into the parsed JSON message, e.g. "data.published_at". */
  path: string;
  format: TimestampFormat;
}

export interface GenericAdapterConfig {
  /** Short label used in output rows and logs, e.g. "acme-feed". */
  name: string;
  /** Full WebSocket URL. May contain the literal token "{API_KEY}". */
  wsUrl: string;
  /** Extra WS upgrade headers. Values may contain the literal token "{API_KEY}". */
  headers?: Record<string, string>;
  /** Extra query params appended to wsUrl. Values may contain "{API_KEY}". */
  queryParams?: Record<string, string>;
  /**
   * If set, only messages whose resolved `fields.type` value is in this list
   * produce a sample. If omitted, every parseable JSON message produces one.
   */
  contentEventTypes?: string[];
  /** Event type value(s) treated as the primary "first sighting" signal for headline stats. */
  primaryEventTypes?: string[];
  fields: {
    /** Dot-path to an event-type string. Optional; omit if the feed has no type field. */
    type?: string;
    /** Dot-path to a stable per-event/content id. Required. */
    id: string;
    /** Dot-path to an account/channel/username field. Optional. */
    account?: string;
    publishedAt?: TimestampFieldConfig;
    providerDetectedAt?: TimestampFieldConfig;
  };
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function toEpochMs(value: unknown, format: TimestampFormat): number | null {
  if (value === null || value === undefined) return null;
  switch (format) {
    case "epoch_ms": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "epoch_s": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n * 1000 : null;
    }
    case "iso8601": {
      if (typeof value !== "string") return null;
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    }
    default:
      return null;
  }
}

function substituteApiKey(
  value: string,
  apiKey: string | null,
): string {
  if (!value.includes("{API_KEY}")) return value;
  if (!apiKey) {
    throw new Error(
      'Config references "{API_KEY}" but no API key was provided. ' +
        "Set the API key via --api-key or the environment variable named in your config's README/notes.",
    );
  }
  return value.split("{API_KEY}").join(apiKey);
}

export function loadGenericConfig(configPath: string): GenericAdapterConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read --config file "${configPath}": ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`--config file "${configPath}" is not valid JSON: ${message}`);
  }

  const config = parsed as Partial<GenericAdapterConfig>;
  if (!config.wsUrl || typeof config.wsUrl !== "string") {
    throw new Error(`--config file "${configPath}" is missing required string field "wsUrl".`);
  }
  if (!config.fields || typeof config.fields.id !== "string") {
    throw new Error(
      `--config file "${configPath}" is missing required string field "fields.id".`,
    );
  }
  if (!config.name || typeof config.name !== "string") {
    throw new Error(`--config file "${configPath}" is missing required string field "name".`);
  }

  return config as GenericAdapterConfig;
}

export class GenericAdapter implements FeedAdapter {
  readonly id = "generic";
  readonly description =
    "Config-driven adapter for any WebSocket feed that sends one JSON object per text frame.";

  private config: GenericAdapterConfig | null = null;

  resolveConnection(opts: ConnectionOptions): ResolvedConnection {
    if (!opts.configPath) {
      throw new Error(
        "Adapter generic requires --config <path-to-json-config>. " +
          "See examples/generic-adapter.example.json.",
      );
    }
    const config = loadGenericConfig(opts.configPath);
    this.config = config;

    const url = new URL(substituteApiKey(opts.wsUrlOverride ?? config.wsUrl, opts.apiKey));
    for (const [key, value] of Object.entries(config.queryParams ?? {})) {
      url.searchParams.set(key, substituteApiKey(value, opts.apiKey));
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      headers[key] = substituteApiKey(value, opts.apiKey);
    }

    return {
      url: url.toString(),
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      authDescription: opts.apiKey
        ? `substituted into config-defined header(s)/query param(s) (value redacted)`
        : "no API key supplied (config did not require one, or none was set)",
    };
  }

  parseMessage(raw: string, _receivedAtMs: number): DetectionSample[] {
    if (!this.config) {
      throw new Error(
        "GenericAdapter.parseMessage called before resolveConnection loaded a config.",
      );
    }
    const config = this.config;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];

    const eventType = config.fields.type
      ? String(getPath(parsed, config.fields.type) ?? "unknown")
      : "unknown";

    if (config.contentEventTypes && !config.contentEventTypes.includes(eventType)) {
      return [];
    }

    const idValue = getPath(parsed, config.fields.id);
    if (idValue === undefined || idValue === null) return [];

    const publishTsMs = config.fields.publishedAt
      ? toEpochMs(
          getPath(parsed, config.fields.publishedAt.path),
          config.fields.publishedAt.format,
        )
      : null;
    const providerDetectTsMs = config.fields.providerDetectedAt
      ? toEpochMs(
          getPath(parsed, config.fields.providerDetectedAt.path),
          config.fields.providerDetectedAt.format,
        )
      : null;

    const sample: DetectionSample = {
      eventId: String(idValue),
      eventType,
      isPrimarySighting: config.primaryEventTypes
        ? config.primaryEventTypes.includes(eventType)
        : true,
      account: config.fields.account
        ? String(getPath(parsed, config.fields.account) ?? "") || null
        : null,
      publishTsMs,
      publishTsSource: publishTsMs !== null ? `generic:${config.fields.publishedAt!.path}` : null,
      providerDetectTsMs,
      providerDetectTsSource:
        providerDetectTsMs !== null
          ? `generic:${config.fields.providerDetectedAt!.path}`
          : config.fields.providerDetectedAt
            ? "field configured but absent/unparseable on this message"
            : "not configured (no providerDetectedAt field set in --config)",
    };

    return [sample];
  }
}
