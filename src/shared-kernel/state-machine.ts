import { appError, err, ok, type Result } from "./result.js";

export type TransitionMap<State extends string> = Readonly<
  Record<State, readonly State[]>
>;

export class StateMachine<State extends string> {
  public constructor(private readonly transitions: TransitionMap<State>) {}

  public canTransition(from: State, to: State): boolean {
    return this.transitions[from].includes(to);
  }

  public transition(from: State, to: State): Result<State> {
    if (!this.canTransition(from, to)) {
      return err(
        appError("INVALID_STATE_TRANSITION", "State transition is not allowed", {
          from,
          to,
        }),
      );
    }
    return ok(to);
  }
}
