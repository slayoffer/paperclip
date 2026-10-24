/** Bound both stage inactivity and total request time. Expiration is final. */
export function withBridgeProgressTimeout<T>(
  work: (
    completeStage: <U>(stage: Promise<U>) => Promise<U>,
    limitDeadline: (deadline: number) => void,
    completeOwnedStage: <U>(stage: Promise<U>) => Promise<U>,
  ) => Promise<T>,
  timeoutMs: number,
  label: string,
  onProgress: () => void,
  totalTimeoutMs = 20_000,
  onTimeout: (error: Error) => void = () => {},
): Promise<T> {
  let active = true;
  let totalDeadline = Date.now() + totalTimeoutMs;
  let stageDeadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout>;
  let renew!: () => void;
  let expire!: () => Error;
  const timeout = new Promise<never>((_resolve, reject) => {
    expire = () => {
      const error = new Error(Date.now() >= totalDeadline
        ? `${label} reached its total request deadline.`
        : `${label} timed out after ${timeoutMs}ms.`);
      if (active) {
        active = false;
        // Fence ownership before tracing or recovery performs an asynchronous call.
        onTimeout(error);
        reject(error);
      }
      return error;
    };
    renew = () => {
      clearTimeout(timer);
      timer = setTimeout(expire, Math.max(0, Math.min(stageDeadline, totalDeadline) - Date.now()));
    };
    renew();
  });
  const limitDeadline = (deadline: number) => {
    if (Number.isFinite(deadline)) totalDeadline = Math.min(totalDeadline, deadline);
    if (!active || Date.now() >= Math.min(stageDeadline, totalDeadline)) throw expire();
    renew();
  };
  const completeStage = async <U>(stage: Promise<U>): Promise<U> => {
    const result = await stage;
    // A late read or authorization result must not continue toward a mutation.
    if (!active || Date.now() >= Math.min(stageDeadline, totalDeadline)) throw expire();
    stageDeadline = Date.now() + timeoutMs;
    renew();
    onProgress();
    return result;
  };
  // An owned handler can deliver its accurate result during the abort grace.
  // Only guarded handler and terminal-delivery stages can use this observer.
  const completeOwnedStage = async <U>(stage: Promise<U>): Promise<U> => {
    const result = await stage;
    if (active) {
      if (Date.now() >= Math.min(stageDeadline, totalDeadline)) expire();
      else {
        stageDeadline = Date.now() + timeoutMs;
        renew();
        onProgress();
      }
    }
    return result;
  };
  return Promise.race([
    Promise.resolve().then(() => work(completeStage, limitDeadline, completeOwnedStage)), timeout,
  ]).finally(() => {
    active = false;
    clearTimeout(timer);
  });
}
