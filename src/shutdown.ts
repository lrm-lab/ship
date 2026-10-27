export type ShutdownStep = { name: string; run: () => Promise<unknown> };

export type ShutdownOptions = {
  /** What to stop, in order: the server first, then what it uses. */
  steps: ShutdownStep[];
  /** After this long the process exits with 1 even if a step has not finished. */
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
};

/**
 * One graceful shutdown for the process. The returned function runs the steps once, however many
 * signals arrive; a failing step is logged and the rest still run; the exit code is 0 only when
 * every step succeeded. A step that never finishes cannot hold the process past `timeoutMs`.
 */
export function createShutdown({
  steps,
  timeoutMs = 10_000,
  exit = process.exit,
  log = console.error,
}: ShutdownOptions): () => Promise<void> {
  let running: Promise<void> | undefined;

  const runAll = async (): Promise<number> => {
    let code = 0;
    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        code = 1;
        log(
          `shutdown: ${step.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return code;
  };

  return () =>
    (running ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          log(`shutdown: not finished after ${timeoutMs} ms, exiting`);
          resolve(1);
        }, timeoutMs);
      });
      const code = await Promise.race([runAll(), timeout]);
      clearTimeout(timer);
      exit(code);
    })());
}
