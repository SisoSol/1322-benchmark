/**
 * Core run loop: connect, receive frames, hand them to the adapter, write
 * rows, track stop conditions, reconnect with the documented backoff policy
 * on drop, and print a summary built only from what this run actually saw.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ConnectionOptions, DetectionSample, FeedAdapter } from "./adapters/types";
import { buildOutputRow, RowWriter, type OutputFormat } from "./output";
import { formatMs, summarize, type SummaryStats } from "./stats";

export interface RunOptions {
  adapter: FeedAdapter;
  connectionOptions: ConnectionOptions;
  testRegion: string;
  outPath: string;
  outFormat: OutputFormat;
  /** 0 = unlimited */
  maxSamples: number;
  /** 0 = unlimited */
  maxDurationMs: number;
  /** Include every progressive-stage event in headline stats, not just the primary-sighting event type. */
  includeAllStagesInStats: boolean;
  maxReconnectAttempts: number;
  quiet: boolean;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30000;

export async function runBenchmark(opts: RunOptions): Promise<number> {
  const runId = randomUUID();
  // Throws with a clear, adapter-authored message on missing key / bad config —
  // intentionally not caught here, so the caller (cli.ts) can print it cleanly
  // and exit(1) without a stack trace.
  const resolved = opts.adapter.resolveConnection(opts.connectionOptions);

  const writer = new RowWriter(opts.outPath, opts.outFormat);

  let sampleIndex = 0;
  let totalRows = 0;
  let providerDetectAvailableCount = 0;
  const primaryDeltas: number[] = [];
  const allStageDeltas: number[] = [];
  const accountsSeen = new Set<string>();

  const startedAtMs = Date.now();
  const deadlineAtMs = opts.maxDurationMs > 0 ? startedAtMs + opts.maxDurationMs : null;

  const log = (msg: string): void => {
    if (!opts.quiet) process.stderr.write(`[1322-benchmark] ${msg}\n`);
  };

  const stopReasonIfAny = (): string | null => {
    if (opts.maxSamples > 0 && sampleIndex >= opts.maxSamples) {
      return `reached --samples ${opts.maxSamples}`;
    }
    if (deadlineAtMs !== null && Date.now() >= deadlineAtMs) {
      return `reached --duration`;
    }
    return null;
  };

  return new Promise<number>((resolvePromise) => {
    let socket: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
    let stopped = false;

    const printSummary = (exitCode: number, stopReason: string): void => {
      const elapsedMs = Date.now() - startedAtMs;
      const primaryStats = summarize(primaryDeltas);
      const allStats = opts.includeAllStagesInStats ? summarize(allStageDeltas) : null;

      const lines: string[] = [];
      lines.push("");
      lines.push("=== 1322-benchmark run summary ===");
      lines.push(`run_id:                 ${runId}`);
      lines.push(`adapter:                ${opts.adapter.id}${opts.connectionOptions.tier ? ` (tier=${opts.connectionOptions.tier})` : ""}`);
      lines.push(`test_region:            ${opts.testRegion}`);
      lines.push(`elapsed:                ${(elapsedMs / 1000).toFixed(1)}s`);
      lines.push(`stop_reason:            ${stopReason}`);
      lines.push(`monitored_accounts:     ${accountsSeen.size > 0 ? [...accountsSeen].join(", ") : "(none observed)"}`);
      lines.push(`total_events_recorded:  ${totalRows}`);
      lines.push(
        `provider_detect_ts_present: ${providerDetectAvailableCount}/${totalRows}` +
          (totalRows > 0 && providerDetectAvailableCount === 0
            ? " (no recorded sample carried one; see each row's provider_detect_ts_source in the output file for the adapter-specific reason)"
            : ""),
      );
      lines.push("");
      lines.push(
        `primary-sighting latency (publish_ts -> client_receive_ts), n=${primaryStats?.count ?? 0}:`,
      );
      lines.push(renderStatsTable(primaryStats));
      if (allStats) {
        lines.push("");
        lines.push(`all-stages latency (--all-events), n=${allStats.count}:`);
        lines.push(renderStatsTable(allStats));
      }
      lines.push("");
      lines.push(`raw samples written to: ${opts.outPath} (${opts.outFormat})`);
      lines.push("===================================");
      lines.push("");

      process.stdout.write(lines.join("\n") + "\n");
      resolvePromise(exitCode);
    };

    const finish = (exitCode: number, reason: string): void => {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        try {
          socket.removeAllListeners();
          socket.close();
        } catch {
          // best-effort close, nothing to recover from here
        }
      }
      writer
        .close()
        .catch((err: unknown) => log(`warning: failed to flush output file cleanly: ${String(err)}`))
        .finally(() => printSummary(exitCode, reason));
    };

    const scheduleReconnect = (reason: string): void => {
      if (stopped) return;
      reconnectAttempts += 1;
      if (reconnectAttempts > opts.maxReconnectAttempts) {
        finish(
          1,
          `giving up after ${opts.maxReconnectAttempts} reconnect attempt(s); last disconnect reason: ${reason}`,
        );
        return;
      }
      const backoffMs = Math.min(
        RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1),
        RECONNECT_CAP_MS,
      );
      log(
        `disconnected (${reason}); reconnecting in ${(backoffMs / 1000).toFixed(0)}s ` +
          `(attempt ${reconnectAttempts}/${opts.maxReconnectAttempts})`,
      );
      reconnectTimer = setTimeout(connect, backoffMs);
    };

    const handleSample = (sample: DetectionSample, receivedAtMs: number): void => {
      sampleIndex += 1;
      totalRows += 1;

      const row = buildOutputRow({
        runId,
        adapterId: opts.adapter.id,
        tier: opts.connectionOptions.tier,
        testRegion: opts.testRegion,
        sampleIndex,
        sample,
        clientReceiveTsMs: receivedAtMs,
      });
      writer.write(row);

      if (row.monitored_account) accountsSeen.add(row.monitored_account);
      if (row.provider_detect_ts_ms !== null) providerDetectAvailableCount += 1;

      if (row.publish_to_client_delta_ms !== null) {
        if (sample.isPrimarySighting) primaryDeltas.push(row.publish_to_client_delta_ms);
        allStageDeltas.push(row.publish_to_client_delta_ms);
      }

      if (!opts.quiet && sampleIndex % 25 === 0) {
        log(`${sampleIndex} sample(s) recorded so far`);
      }
    };

    function connect(): void {
      log(`connecting to ${resolved.url} [auth: ${resolved.authDescription}]`);
      const ws = new WebSocket(resolved.url, resolved.headers ? { headers: resolved.headers } : undefined);
      socket = ws;

      ws.on("open", () => {
        reconnectAttempts = 0;
        log("connected, waiting for events");
      });

      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (stopped) return;
        const receivedAtMs = Date.now();
        const text = isBinary
          ? Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(data as ArrayBuffer).toString("utf8")
          : data.toString();

        let samples: DetectionSample[];
        try {
          samples = opts.adapter.parseMessage(text, receivedAtMs);
        } catch (err) {
          log(
            `adapter threw while parsing a frame, skipping it: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }

        for (const sample of samples) {
          handleSample(sample, receivedAtMs);
          const reason = stopReasonIfAny();
          if (reason) {
            finish(0, reason);
            return;
          }
        }
      });

      ws.on("error", (err: Error) => {
        log(`socket error: ${err.message}`);
      });

      ws.on("close", (code: number, reasonBuf: Buffer) => {
        if (stopped) return;
        const reasonText = reasonBuf.length > 0 ? reasonBuf.toString("utf8") : "no reason given";
        scheduleReconnect(`code ${code}, ${reasonText}`);
      });
    }

    process.once("SIGINT", () => finish(0, "interrupted (SIGINT / Ctrl-C)"));
    process.once("SIGTERM", () => finish(0, "terminated (SIGTERM)"));

    connect();
  });
}

function renderStatsTable(stats: SummaryStats | null): string {
  if (!stats) return "  (no samples with a usable publish timestamp were recorded)";
  return [
    `  count: ${stats.count}`,
    `  min:   ${formatMs(stats.min)}`,
    `  p50:   ${formatMs(stats.p50)}`,
    `  p90:   ${formatMs(stats.p90)}`,
    `  p95:   ${formatMs(stats.p95)}`,
    `  p99:   ${formatMs(stats.p99)}`,
    `  max:   ${formatMs(stats.max)}`,
    `  mean:  ${formatMs(stats.mean)}`,
    `  stddev:${formatMs(stats.stddev)}`,
  ].join("\n");
}
