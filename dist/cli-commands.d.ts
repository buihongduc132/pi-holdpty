/**
 * CLI argument parsing and subcommand logic for new pi-holdpty commands:
 * watch, wait (extended), tail-events.
 *
 * These are extracted from cli.ts for testability.
 */
import { NdjsonWriter } from "./event-stream.js";
import { WatcherFilter, type PatternSpec } from "./watcher-filter.js";
export interface WatchArgs {
    session?: string;
    all?: boolean;
    patterns: string[];
    labels: string[];
    debounceMs: number;
    maxBufferBytes: number;
    from: "start" | "now";
    exitOn?: string;
}
export interface TailEventsArgs {
    session?: string;
    all?: boolean;
    patterns: string[];
    labels: string[];
    debounceMs: number;
    maxBufferBytes: number;
}
export interface WaitArgs {
    session: string;
}
export declare function parseWatchArgs(args: string[]): WatchArgs;
export declare function parseTailEventsArgs(args: string[]): TailEventsArgs;
export declare function parseWaitArgs(args: string[]): WaitArgs;
export interface WatcherPipelineOptions {
    session: string;
    patterns: PatternSpec[];
    debounceMs: number;
    maxBufferBytes: number;
    exitOnPattern?: RegExp;
    writer: NdjsonWriter;
    onExit?: () => void;
}
/**
 * Creates a watcher filter that pipes events to an NDJSON writer.
 * Returns the filter so callers can feed data to it.
 */
export declare function createWatcherPipeline(opts: WatcherPipelineOptions): WatcherFilter;
