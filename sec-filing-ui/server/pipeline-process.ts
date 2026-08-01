import type { ChildProcess } from "child_process";

// Helpers for driving the spawned Python pipeline child. Kept out of routes.ts
// so they can be exercised directly by the regression suite.

/**
 * Reassemble newline-delimited records from arbitrarily-chunked stream data.
 *
 * The pipeline speaks JSONL on stdout, but a chunk boundary can land anywhere —
 * including the middle of a record. Splitting each chunk independently produced
 * two fragments that both failed to parse and were both discarded, so a
 * "complete" record could vanish entirely: the PDF was rendered but never
 * copied into app storage, and the filing sat at "rendering" until the stale
 * sweep flipped it to error 15 minutes later.
 *
 * `push` emits every complete line and holds the trailing partial for the next
 * chunk. `flush` emits a final record that arrived without a trailing newline.
 */
export function createLineReader(
  onLine: (line: string) => void,
  // Bound the carry-over so a pathological line with no newline (a traceback
  // printed to stdout, say) can't grow without limit.
  maxTailBytes = 4 * 1024 * 1024,
) {
  let tail = "";
  return {
    push(chunk: string): void {
      const lines = (tail + chunk).split("\n");
      // The final element is whatever followed the last newline: a partial
      // record if the chunk was cut mid-line, "" if it ended cleanly. Either
      // way it belongs to the next chunk, not this one.
      tail = lines.pop() ?? "";
      if (tail.length > maxTailBytes) tail = "";
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    },
    flush(): void {
      const rest = tail;
      tail = "";
      if (rest.trim()) onLine(rest);
    },
  };
}

/**
 * Signal the pipeline's whole process group.
 *
 * The child is spawned detached, so python and every Chromium it launches share
 * a process group whose id is the child's pid. Signalling -pid reaches all of
 * them; signalling the child alone leaves orphaned browsers holding memory
 * after a "successful" cancel.
 */
export function signalPipelineGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already reaped, or the platform refused a group signal — fall back
    // to the child itself rather than giving up on the kill entirely.
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

export const PIPELINE_KILL_GRACE_MS = 3000;
const PIPELINE_KILL_HARD_MS = 2000;

/**
 * SIGTERM the pipeline group, escalate to SIGKILL if it hasn't exited, and
 * resolve once it's actually gone (or we've given up waiting).
 *
 * The escalation check must NOT use `child.killed`: that flag records only that
 * a signal was SENT, so it flips true the instant SIGTERM leaves — even for a
 * process that ignores SIGTERM entirely. The old `if (!child.killed)` guard was
 * therefore always false and SIGKILL never fired, so cancelling a wedged render
 * reported success while python and Chromium kept running. `exitCode` and
 * `signalCode` are both null until the process really exits.
 */
export function stopPipeline(
  child: ChildProcess,
  graceMs = PIPELINE_KILL_GRACE_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let hardTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(graceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      child.removeListener("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    signalPipelineGroup(child, "SIGTERM");
    const graceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        console.warn("[cancel] Pipeline ignored SIGTERM — escalating to SIGKILL.");
        signalPipelineGroup(child, "SIGKILL");
      }
      // SIGKILL can't be blocked, but don't hold the request open forever if
      // the exit event never arrives.
      hardTimer = setTimeout(finish, PIPELINE_KILL_HARD_MS);
      hardTimer.unref?.();
    }, graceMs);
    graceTimer.unref?.();
  });
}
