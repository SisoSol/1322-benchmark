#!/usr/bin/env node
/**
 * 1322-benchmark CLI entry point.
 *
 * Argument parsing only lives here. All the actual work (connecting,
 * parsing frames, computing stats, writing output) lives in src/run.ts and
 * src/adapters/*. Keeping this file thin makes it easy to verify the CLI
 * "does the boring, honest thing": parse flags, fail clearly on bad input,
 * and hand off to the runner.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { ADAPTER_IDS, createAdapter } from "./adapters/registry";
import { runBenchmark } from "./run";
import type { OutputFormat } from "./output";

// Read at runtime (not compile-time import) so the compiled dist/cli.js
// doesn't need package.json inside tsc's rootDir, and so a version bump
// never requires a rebuild.
function readOwnVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, "..", "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parsePositiveInt(label: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      throw new InvalidArgumentError(`${label} must be a non-negative integer, got "${value}".`);
    }
    return n;
  };
}

function defaultOutPath(format: OutputFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `./benchmark-${stamp}.${format === "csv" ? "csv" : "jsonl"}`;
}

const program = new Command();

program
  .name("1322-benchmark")
  .description(
    "Vendor-neutral CLI for measuring real-time detection latency of WebSocket " +
      "social/crypto data feeds. Ships an adapter for the 1322 X/Twitter feed " +
      "plus a generic, config-driven adapter for any JSON WebSocket stream.",
  )
  .version(readOwnVersion());

program
  .command("run")
  .description("Connect to a feed and record per-event latency samples until a stop condition is hit.")
  .requiredOption(
    "--region <label>",
    "Free-text label for where this run executed (e.g. us-east-1, home-fiber-eu). " +
      "This tool cannot reliably auto-detect your network region, so you must supply it. " +
      "Recorded in every output row and in the summary.",
  )
  .option(
    "--adapter <id>",
    `Which adapter to use: ${ADAPTER_IDS.join(" | ")}.`,
    "x1322",
  )
  .option("--tier <tier>", "1322 X/Twitter tier: normal | ultimate.", "normal")
  .option(
    "--api-key <key>",
    "API key for the target feed. Prefer the X1322_API_KEY / API_KEY environment variable over this flag " +
      "so the key doesn't end up in shell history or process listings.",
  )
  .option("--ws-url <url>", "Override the adapter's default WebSocket URL.")
  .option(
    "--config <path>",
    "Path to a generic-adapter JSON config file (required when --adapter generic). " +
      "See examples/generic-adapter.example.json.",
  )
  .option(
    "--samples <n>",
    "Stop after recording this many primary-sighting samples. 0 = unlimited (stop with Ctrl-C or --duration).",
    parsePositiveInt("--samples"),
    0,
  )
  .option(
    "--duration <seconds>",
    "Stop after this many seconds. 0 = unlimited (stop with Ctrl-C or --samples).",
    parsePositiveInt("--duration"),
    0,
  )
  .option("--out <path>", "Output file path. Defaults to ./benchmark-<timestamp>.<format>.")
  .option("--format <format>", "Output format: jsonl | csv.", "jsonl")
  .option(
    "--all-events",
    "Also include non-primary progressive-stage events (e.g. tweet.update, tweet.full) in the printed " +
      "summary stats, in addition to the primary-sighting event type. All event types are always written " +
      "to the output file regardless of this flag.",
    false,
  )
  .option(
    "--max-reconnects <n>",
    "Give up and exit non-zero after this many consecutive failed reconnect attempts.",
    parsePositiveInt("--max-reconnects"),
    5,
  )
  .option("--quiet", "Suppress progress logging on stderr (summary and errors still print).", false)
  .action(async (rawOptions: {
    region: string;
    adapter: string;
    tier: string;
    apiKey?: string;
    wsUrl?: string;
    config?: string;
    samples: number;
    duration: number;
    out?: string;
    format: string;
    allEvents: boolean;
    maxReconnects: number;
    quiet: boolean;
  }) => {
    const format: OutputFormat = rawOptions.format === "csv" ? "csv" : "jsonl";
    if (rawOptions.format !== "csv" && rawOptions.format !== "jsonl") {
      console.error(`Error: --format must be "jsonl" or "csv", got "${rawOptions.format}".`);
      process.exitCode = 1;
      return;
    }

    let adapter;
    try {
      adapter = createAdapter(rawOptions.adapter);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    const apiKey =
      rawOptions.apiKey ?? process.env.X1322_API_KEY ?? process.env.API_KEY ?? null;

    const outPath = rawOptions.out ?? defaultOutPath(format);

    try {
      const exitCode = await runBenchmark({
        adapter,
        connectionOptions: {
          apiKey,
          tier: rawOptions.tier ?? null,
          wsUrlOverride: rawOptions.wsUrl ?? null,
          configPath: rawOptions.config ?? null,
        },
        testRegion: rawOptions.region,
        outPath,
        outFormat: format,
        maxSamples: rawOptions.samples,
        maxDurationMs: rawOptions.duration * 1000,
        includeAllStagesInStats: rawOptions.allEvents,
        maxReconnectAttempts: rawOptions.maxReconnects,
        quiet: rawOptions.quiet,
      });
      process.exitCode = exitCode;
    } catch (err) {
      // Adapter-authored, human-readable errors (missing API key, bad config,
      // unknown tier, ...) land here. Print the message only — no stack trace —
      // and exit non-zero instead of letting Node dump an unhandled rejection.
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
