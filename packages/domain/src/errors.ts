import { HTTP_STATUS_FOR_CODE, type PermissionPolicy, type PolicyDecision } from "@grove/protocol";

export class GroveError extends Error {
  code: string;
  capability?: keyof PermissionPolicy;
  httpStatus: number;
  hint?: string;
  suggestedRoom?: string;
  details?: Record<string, unknown>;
  /**
   * §5.5. Which ceiling refused, carried straight off the `PolicyDecision`
   * this error was flattened from. `capability` alone cannot say: a space
   * denial has to borrow an actor-shaped capability name, so without these two
   * "your owner did not grant this", "this space does not allow it" and "their
   * setting, not yours" are indistinguishable to a client.
   *
   * Set only on `PERMISSION_DENIED`, and only ever copied from a decision that
   * derived them — never guessed here. `subject` is meaningful only when
   * `source` is `"actor"`; the kernel already omits it otherwise.
   */
  source?: PolicyDecision["source"];
  subject?: PolicyDecision["subject"];

  constructor(
    code: string,
    message: string,
    opts?: {
      capability?: keyof PermissionPolicy;
      hint?: string;
      suggestedRoom?: string;
      httpStatus?: number;
      details?: Record<string, unknown>;
      source?: PolicyDecision["source"];
      subject?: PolicyDecision["subject"];
    },
  ) {
    super(message);
    this.name = "GroveError";
    this.code = code;
    this.capability = opts?.capability;
    this.hint = opts?.hint;
    this.suggestedRoom = opts?.suggestedRoom;
    this.httpStatus = opts?.httpStatus ?? HTTP_STATUS_FOR_CODE[code] ?? 400;
    this.details = opts?.details;
    this.source = opts?.source;
    this.subject = opts?.subject;
  }
}
