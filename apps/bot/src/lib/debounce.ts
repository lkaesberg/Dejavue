/**
 * Keyed trailing debounce for capture jobs.
 *
 * Guarantee: after the last call for a key, `run` executes at least once with
 * the latest payload — including calls that arrive while a run for that key is
 * already in flight (they mark the key dirty and trigger exactly one follow-up
 * run when the current one finishes).
 *
 * The previous skip-if-scheduled `Set` debounce lost exactly those calls: a
 * message posted while a transcript capture was mid-flight scheduled nothing,
 * so it only reached the KB when some later message re-triggered a capture —
 * possibly much later, or never.
 */
export function keyedTrailingDebounce<T>(
  delayMs: number,
  run: (payload: T) => Promise<void>,
  onError: (err: unknown, payload: T) => void,
): (key: string, payload: T) => void {
  interface Entry {
    payload: T;
    running: boolean;
    /** A call arrived while running — re-run once the current run finishes. */
    dirty: boolean;
  }
  const entries = new Map<string, Entry>();

  const schedule = (key: string): void => {
    const timer = setTimeout(() => {
      const e = entries.get(key);
      if (!e) return;
      e.running = true;
      e.dirty = false;
      const payload = e.payload;
      void run(payload)
        .catch((err) => onError(err, payload))
        .finally(() => {
          e.running = false;
          if (e.dirty) schedule(key);
          else entries.delete(key);
        });
    }, delayMs);
    timer.unref();
  };

  return (key, payload) => {
    const e = entries.get(key);
    if (!e) {
      entries.set(key, { payload, running: false, dirty: false });
      schedule(key);
      return;
    }
    e.payload = payload; // freshest handle wins
    if (e.running) e.dirty = true;
    // Not running → a timer is already pending and will pick up the new payload.
  };
}
