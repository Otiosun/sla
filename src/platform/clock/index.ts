export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class ManualClock implements Clock {
  private current: Date;

  public constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }

  public now(): Date {
    return new Date(this.current.getTime());
  }

  public advanceMs(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) {
      throw new RangeError("Clock advance must be finite");
    }
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
