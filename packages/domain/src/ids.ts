import { ulid } from "ulid";
import { ID_PREFIX } from "@grove/protocol";

export function newId(kind: keyof typeof ID_PREFIX): string {
  return `${ID_PREFIX[kind]}${ulid()}`;
}

export function newUlid(): string {
  return ulid();
}
