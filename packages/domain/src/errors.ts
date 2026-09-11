import { HTTP_STATUS_FOR_CODE, type PermissionPolicy } from "@grove/protocol";

export class GroveError extends Error {
  code: string;
  capability?: keyof PermissionPolicy;
  httpStatus: number;
  hint?: string;
  suggestedRoom?: string;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts?: {
      capability?: keyof PermissionPolicy;
      hint?: string;
      suggestedRoom?: string;
      httpStatus?: number;
      details?: Record<string, unknown>;
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
  }
}
