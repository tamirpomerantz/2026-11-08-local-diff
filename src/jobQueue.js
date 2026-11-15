export function createJobQueue({ rewriteJobs, generateJob, unloadText, onIdle, log = console.log } = {}) {
  const pending = [];
  const textWaiters = [];
  let pumping = false;
  let phase = "idle";
  let current = null;

  function activeJobs() {
    return pending.filter((job) => !job.cancelled && job.stage !== "done");
  }

  function snapshot() {
    const jobs = activeJobs();
    return {
      phase,
      current: current?.id ?? null,
      waiting: jobs.length,
      rewrite: jobs.filter((job) => job.stage === "rewrite").length,
      generate: jobs.filter((job) => job.stage === "generate").length,
      text: textWaiters.length,
    };
  }

  function logState(extra) {
    const state = snapshot();
    log(
      `[queue] ${extra} · phase=${state.phase} rewrite=${state.rewrite} generate=${state.generate} waiting=${state.waiting}`,
    );
  }

  function remove(job) {
    const index = pending.indexOf(job);
    if (index >= 0) pending.splice(index, 1);
  }

  function fail(job, error) {
    job.stage = "done";
    job.cancelled = job.cancelled || Boolean(error?.cancelled);
    const message = error?.cancelled || job.cancelled ? "Generation cancelled." : String(error?.message || error);
    try {
      job.send?.({ type: "error", error: message });
      job.res?.end?.();
    } catch {
      // Connection may already be gone.
    }
    remove(job);
  }

  function prune() {
    for (const job of [...pending]) {
      if (job.stage === "done") {
        remove(job);
        continue;
      }
      if (job.cancelled && job !== current) fail(job, { cancelled: true });
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (true) {
        prune();
        const waiters = textWaiters.splice(0);
        const rewriteBatch = pending.filter((job) => job.stage === "rewrite" && !job.cancelled);
        const hadText = waiters.length || rewriteBatch.length;
        if (hadText) {
          phase = "rewrite";
          if (waiters.length) {
            logState(`text tasks ${waiters.length}`);
            for (const waiter of waiters) {
              try {
                waiter.resolve(await waiter.fn());
              } catch (error) {
                waiter.reject(error);
              }
            }
          }
          if (rewriteBatch.length) {
            current = rewriteBatch[0];
            logState(`rewrite batch ${rewriteBatch.length}`);
            try {
              await rewriteJobs(rewriteBatch);
            } catch (error) {
              for (const job of rewriteBatch) {
                if (job.stage === "rewrite") fail(job, error);
              }
            }
            current = null;
          }
        }

        const generateBatch = pending.filter((job) => job.stage === "generate" && !job.cancelled);
        if (!generateBatch.length) {
          if (!hadText) break;
          continue;
        }
        phase = "generate";
        logState(`generate batch ${generateBatch.length}`);
        for (const gen of generateBatch) {
          if (gen.cancelled || gen.stage !== "generate") continue;
          current = gen;
          logState(`generate ${gen.action || "klein"}`);
          try {
            await generateJob(gen);
            gen.stage = "done";
            remove(gen);
          } catch (error) {
            fail(gen, error);
          }
          current = null;
        }
      }
    } catch (error) {
      log(`[queue] pump error: ${error?.message || error}`);
    } finally {
      phase = "idle";
      pumping = false;
      current = null;
      try {
        await unloadText?.();
      } catch {
        // Unload is best-effort.
      }
      prune();
      if (activeJobs().length || textWaiters.length) pump();
      else {
        logState("idle");
        try {
          await onIdle?.();
        } catch {
          // Idle hooks are best-effort.
        }
      }
    }
  }

  return {
    enqueue(job) {
      pending.push(job);
      logState(`+${job.action || job.stage}`);
      pump();
      return job;
    },
    runText(fn) {
      return new Promise((resolve, reject) => {
        textWaiters.push({ fn, resolve, reject });
        logState("+text");
        pump();
      });
    },
    cancel(id) {
      const match = String(id ?? "");
      if (!match) return;
      for (const job of pending) {
        if (job.id === match || job.clientId === match) {
          job.cancelled = true;
          job.abort?.abort();
        }
      }
      if (current && (current.id === match || current.clientId === match)) {
        current.cancelled = true;
        current.abort?.abort();
      }
    },
    cancelAll() {
      for (const job of pending) {
        job.cancelled = true;
        job.abort?.abort();
      }
      if (current) {
        current.cancelled = true;
        current.abort?.abort();
      }
    },
    snapshot,
    isBusy() {
      return pumping || activeJobs().length > 0 || textWaiters.length > 0;
    },
  };
}
