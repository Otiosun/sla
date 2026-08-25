export const MAX_SLEEP_MS = 2_147_483_647;

export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(milliseconds: number): Promise<void>;
}

export const systemClock: Clock = Object.freeze({
  now: () => new Date(),
});

export const systemSleeper: Sleeper = Object.freeze({
  sleep: async (milliseconds: number) => {
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > MAX_SLEEP_MS
    ) {
      throw new RangeError(`sleep milliseconds must be an integer in 0..${MAX_SLEEP_MS}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
});

export class FixedClock implements Clock {
  #milliseconds: number;

  constructor(instant: Date) {
    const milliseconds = instant.getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new RangeError("fixed clock instant must be valid");
    }
    this.#milliseconds = milliseconds;
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }

  set(instant: Date): void {
    const milliseconds = instant.getTime();
    if (!Number.isFinite(milliseconds)) {
      throw new RangeError("fixed clock instant must be valid");
    }
    this.#milliseconds = milliseconds;
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) {
      throw new RangeError("clock advance must be finite");
    }
    const next = this.#milliseconds + milliseconds;
    if (!Number.isFinite(new Date(next).getTime())) {
      throw new RangeError("clock advance would create an invalid instant");
    }
    this.#milliseconds = next;
  }
}
