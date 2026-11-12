export function createAbortError(message = "Aborted"): DOMException {
  return new DOMException(message, "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  }
  return false;
}

export function attachAbortSignal(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Stop awaiting preparation work that does not itself expose a cancellation API. */
export function awaitWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(createAbortError());
        };
        pending.then(value => {
            signal.removeEventListener("abort", onAbort);
            if (signal.aborted) reject(createAbortError());
            else resolve(value);
        }, error => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
        });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
    });
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
