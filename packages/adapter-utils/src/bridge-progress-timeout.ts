/** Bound the time without a completed stage. Late results cannot renew the timer. */
export function withBridgeProgressTimeout<T>(
  work: (completeStage: <U>(stage: Promise<U>) => Promise<U>) => Promise<T>,
  timeoutMs: number,
  label: string,
  onProgress: () => void,
): Promise<T> {
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  let renew: () => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    renew = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        active = false;
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    };
    renew();
  });
  const completeStage = async <U>(stage: Promise<U>): Promise<U> => {
    const result = await stage;
    if (active) {
      renew();
      onProgress();
    }
    return result;
  };
  // Start work after the timeout exists. A synchronous error also clears it.
  return Promise.race([Promise.resolve().then(() => work(completeStage)), timeout]).finally(() => {
    active = false;
    clearTimeout(timer);
  });
}
