/**
 * Output row schema and file writers (JSONL / CSV).
 *
 * Column names intentionally spell out what each timestamp actually is,
 * per the audit checklist this tool implements: publish-timestamp source,
 * provider-detect timestamp (if any), client-receive timestamp, computed
 * deltas, test region, monitored account, and enough run metadata to
 * reproduce or audit the run later.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import type { DetectionSample } from "./adapters/types";

export const OUTPUT_SCHEMA_VERSION = 1;

export interface OutputRow {
  schema_version: number;
  run_id: string;
  adapter: string;
  tier: string | null;
  test_region: string;
  sample_index: number;
  received_at_iso: string;
  event_id: string;
  event_type: string;
  is_primary_sighting: boolean;
  monitored_account: string | null;
  publish_ts_source: string | null;
  publish_ts_ms: number | null;
  provider_detect_ts_source: string | null;
  provider_detect_ts_ms: number | null;
  client_receive_ts_ms: number;
  publish_to_client_delta_ms: number | null;
  provider_detect_to_client_delta_ms: number | null;
}

export function buildOutputRow(args: {
  runId: string;
  adapterId: string;
  tier: string | null;
  testRegion: string;
  sampleIndex: number;
  sample: DetectionSample;
  clientReceiveTsMs: number;
}): OutputRow {
  const { runId, adapterId, tier, testRegion, sampleIndex, sample, clientReceiveTsMs } = args;

  return {
    schema_version: OUTPUT_SCHEMA_VERSION,
    run_id: runId,
    adapter: adapterId,
    tier,
    test_region: testRegion,
    sample_index: sampleIndex,
    received_at_iso: new Date(clientReceiveTsMs).toISOString(),
    event_id: sample.eventId,
    event_type: sample.eventType,
    is_primary_sighting: sample.isPrimarySighting,
    monitored_account: sample.account,
    publish_ts_source: sample.publishTsSource,
    publish_ts_ms: sample.publishTsMs,
    provider_detect_ts_source: sample.providerDetectTsSource,
    provider_detect_ts_ms: sample.providerDetectTsMs,
    client_receive_ts_ms: clientReceiveTsMs,
    publish_to_client_delta_ms:
      sample.publishTsMs !== null ? clientReceiveTsMs - sample.publishTsMs : null,
    provider_detect_to_client_delta_ms:
      sample.providerDetectTsMs !== null
        ? clientReceiveTsMs - sample.providerDetectTsMs
        : null,
  };
}

const CSV_COLUMNS: (keyof OutputRow)[] = [
  "schema_version",
  "run_id",
  "adapter",
  "tier",
  "test_region",
  "sample_index",
  "received_at_iso",
  "event_id",
  "event_type",
  "is_primary_sighting",
  "monitored_account",
  "publish_ts_source",
  "publish_ts_ms",
  "provider_detect_ts_source",
  "provider_detect_ts_ms",
  "client_receive_ts_ms",
  "publish_to_client_delta_ms",
  "provider_detect_to_client_delta_ms",
];

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export type OutputFormat = "jsonl" | "csv";

export class RowWriter {
  private stream: WriteStream;
  private format: OutputFormat;
  private headerWritten = false;

  constructor(filePath: string, format: OutputFormat) {
    this.format = format;
    this.stream = createWriteStream(filePath, { flags: "w" });
  }

  write(row: OutputRow): void {
    if (this.format === "jsonl") {
      this.stream.write(JSON.stringify(row) + "\n");
      return;
    }

    if (!this.headerWritten) {
      this.stream.write(CSV_COLUMNS.join(",") + "\n");
      this.headerWritten = true;
    }
    this.stream.write(CSV_COLUMNS.map((c) => csvEscape(row[c])).join(",") + "\n");
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.once("error", reject);
      this.stream.end(() => resolve());
    });
  }
}
