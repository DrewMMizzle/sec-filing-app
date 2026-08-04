import fs from "fs";
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
 * True if any process is still RUNNING in the group led by `pid`.
 *
 * A process group outlives its leader — the group id stays valid, and can't be
 * recycled, while any member exists — so this answers "is Chromium still
 * running?" even after python has exited.
 *
 * Zombies are deliberately excluded, and that distinction is the whole reason
 * this reads /proc instead of using `kill(-pid, 0)`. A killed child sits in Z
 * state until its parent (PID 1, once reparented) reaps it, which took ~1.4s
 * when measured in this container. `kill(-pid, 0)` succeeds for zombies, so it
 * reports a group as alive when everything in it is already dead — which would
 * make every ordinary cancel wait out the full escalation window for processes
 * that hold no memory and no browser. A zombie is exactly what we do NOT care
 * about here.
 *
 * Falls back to the signal-0 probe where /proc isn't available (macOS dev
 * machines); production is Linux, where the accurate path is the one taken.
 */
export function pipelineGroupIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    const entries = fs.readdirSync("/proc");
    let sawAnyProcess = false;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      sawAnyProcess = true;
      let stat: string;
      try {
        stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch {
        continue; // exited between readdir and read
      }
      // comm (field 2) is parenthesised and may contain spaces or parens
      // itself, so parse from the LAST ")": state, ppid, pgrp follow it.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const state = after[0];
      const pgrp = Number(after[2]);
      if (pgrp === pid && state !== "Z") return true;
    }
    if (sawAnyProcess) return false;
  } catch {
    // no /proc — fall through to the portable probe
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal the pipeline's whole process group.
 *
 * The child is spawned detached, so python and every Chromium it launches share
 * a process group whose id is the child's pid. Signalling -pid reaches all of
 * them; signalling the child alone leaves orphaned browsers holding memory
 * after a "successful" cancel.
 *
 * Takes a pid rather than the ChildProcess on purpose. The previous version
 * consulted `child.exitCode` first and returned early once the child was gone,
 * which meant it could not be used to clean up a group that OUTLIVED its
 * leader — the one case that matters here.
 */
export function signalPipelineGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already reaped, or the platform refused a group signal — fall back
    // to the pid alone rather than giving up on the kill entirely.
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export const PIPELINE_KILL_GRACE_MS = 3000;
const PIPELINE_KILL_HARD_MS = 2000;

/**
 * SIGTERM the pipeline group, escalate to SIGKILL if anything is still running,
 * and resolve once the group is actually empty (or we've given up waiting).
 *
 * Two bugs live here historically, and the second was only visible in
 * production.
 *
 * The first: the escalation check used `child.killed`, which records only that
 * a signal was SENT — true the instant SIGTERM leaves, even for a process that
 * ignores it — so SIGKILL never fired at all.
 *
 * The second: once that was fixed, everything still keyed off the DIRECT child.
 * A cancel measured against the live deployment returned in 73ms, because
 * python exits on SIGTERM immediately — and the child's `exit` event cancelled
 * the pending SIGKILL timer. Any group member that had ignored SIGTERM was
 * therefore never escalated against. That member is Chromium, and an orphaned
 * Chromium holding memory is the entire reason this function exists. A fast
 * return is correct when the group is genuinely empty; it is exactly wrong when
 * it isn't, and nothing distinguished the two.
 *
 * So the wait is now on the GROUP, not the child: the child exiting only ends
 * the wait if nothing else in its group is left.
 */
export function stopPipeline(
  child: ChildProcess,
  graceMs = PIPELINE_KILL_GRACE_MS,
): Promise<void> {
  const pid = child.pid;
  const childGone = () => child.exitCode !== null || child.signalCode !== null;
  if (childGone() && !pipelineGroupIsAlive(pid)) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    let hardTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(graceTimer);
      clearInterval(poll);
      if (hardTimer) clearTimeout(hardTimer);
      child.removeListener("exit", onChildExit);
      resolve();
    };
    const settledCleanly = () => childGone() && !pipelineGroupIsAlive(pid);
    // The child exiting is only the end of the story if its group went with it.
    const onChildExit = () => {
      if (settledCleanly()) finish();
    };
    child.once("exit", onChildExit);
    // The child's exit event can beat its siblings' teardown by a few
    // milliseconds, so a single check at exit reports the group as alive and
    // then waits out the entire grace window — turning every ordinary cancel
    // into a multi-second one. Poll instead: return the moment the group is
    // genuinely empty, which is what the sub-second cancels measured against
    // the live deployment actually represent.
    const poll = setInterval(() => {
      if (settledCleanly()) finish();
    }, 50);

    signalPipelineGroup(pid, "SIGTERM");
    const graceTimer = setTimeout(() => {
      if (!childGone() || pipelineGroupIsAlive(pid)) {
        console.warn(
          "[cancel] Pipeline group ignored SIGTERM — escalating to SIGKILL " +
            `(child ${childGone() ? "already exited" : "still running"}).`,
        );
        signalPipelineGroup(pid, "SIGKILL");
      }
      // SIGKILL can't be blocked, but the child's `exit` may already have fired,
      // so there is no event left to wait on — resolve on a short timer instead
      // of holding the request open indefinitely.
      // NOT unref'd: resolving this promise depends on these firing. An
      // unref'd timer lets the process exit before the escalation completes,
      // which is how the fix could quietly do nothing. Both are cleared in
      // finish(), and the worst case is a bounded 5s.
      hardTimer = setTimeout(finish, PIPELINE_KILL_HARD_MS);
    }, graceMs);
  });
}
