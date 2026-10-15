import { watch } from "node:fs";
import * as path from "node:path";
import { indexRepo } from "./build.js";

const IGNORED = /(^|[\\/])(\.git|node_modules|\.cbtg|dist|build|coverage|target|\.angular)([\\/]|$)/;

export interface WatchOptions {
  root: string;
  graphDir?: string;
  debounceMs?: number;
  signal?: AbortSignal;
  /** Called after each (re)index with its stats line, or with the error text if indexing failed. */
  onIndex?: (line: string, ok: boolean) => void;
}

/**
 * Re-runs the incremental index after files change. Events are debounced into one run, runs never overlap (a change
 * during a run schedules exactly one more), and changes inside ignored folders or the graph directory are skipped.
 * Resolves when the signal aborts. Only reads the repository; never executes anything in it.
 */
export async function watchRepo(o: WatchOptions): Promise<void> {
  const root = path.resolve(o.root);
  const graphAbs = o.graphDir ? path.resolve(o.graphDir) : undefined;
  const say = o.onIndex ?? (() => undefined);
  let timer: NodeJS.Timeout | undefined, running = false, again = false;

  const run = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    try {
      const { stats, graph } = await indexRepo(root, o.graphDir);
      say(`indexed ${stats.files} files (parsed ${stats.parsed}, reused ${stats.reused}, removed ${stats.removed}); ${graph.nodes.length} nodes, ${graph.edges.length} edges`, true);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), false);
    }
    running = false;
    if (again) { again = false; await run(); }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void run(), o.debounceMs ?? 300); };

  const w = watch(root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const abs = path.join(root, name.toString());
    if (IGNORED.test(name.toString()) || (graphAbs && abs.startsWith(graphAbs))) return;
    schedule();
  });
  await run();
  await new Promise<void>((resolve) => {
    const stop = () => { clearTimeout(timer); w.close(); resolve(); };
    if (o.signal?.aborted) stop();
    else o.signal?.addEventListener("abort", stop, { once: true });
  });
}
