const tails = new Map<string, Promise<void>>();

/** Runs tasks for one key in order. A failure still lets the next task start. */
export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(task, () => task());
  const done = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, done);
  return run;
}
