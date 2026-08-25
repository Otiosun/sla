import { appError, err, ok, type AppError, type Result } from "./result.js";

export type TransitionMap<State extends string> = Readonly<Record<State, readonly State[]>>;

export type InvalidTransitionError<State extends string> = AppError<
  "STATE.INVALID_TRANSITION",
  { readonly from: State; readonly to: State }
>;

export class StateMachine<State extends string> {
  readonly #transitions: TransitionMap<State>;

  constructor(transitions: TransitionMap<State>) {
    this.#transitions = transitions;
  }

  canTransition(from: State, to: State): boolean {
    return this.#transitions[from].includes(to);
  }

  transition(from: State, to: State): Result<State, InvalidTransitionError<State>> {
    if (this.canTransition(from, to)) {
      return ok(to);
    }

    return err(
      appError({
        code: "STATE.INVALID_TRANSITION",
        message: "State transition is not allowed",
        details: { from, to },
      }),
    );
  }
}
