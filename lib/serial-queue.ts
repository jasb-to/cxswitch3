/**
 * Queue async state mutations in invocation order. A rejected operation does not
 * poison the queue, and the next queued operation still runs.
 */
export function createSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
}
