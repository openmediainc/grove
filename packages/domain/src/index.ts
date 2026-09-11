export { loadConfig, isProduction, type GroveConfig } from "./config.js";
export { createPool, withTx, type Pool } from "./db.js";
export { migrate } from "./migrate.js";
export { GroveError } from "./errors.js";
export { newId } from "./ids.js";
export type { GroveStore } from "./store.js";
export { IdentityService } from "./services/identity.js";
export { PresenceService } from "./services/presence.js";
export { SpeechService, spectatorMayHear, SPECTATOR_RECIPIENT, assertValidOwnerChannelFlag } from "./services/speech.js";
export { ObserveService } from "./services/observe.js";
export { WorldService } from "./services/world.js";
export { ModerationService } from "./services/moderation.js";
export { MailboxService } from "./services/mailbox.js";
export { NoticeService } from "./services/notices.js";
export { FlagService } from "./services/flags.js";
export { QuotaService, RedisRateLimiter, MemoryRateLimiter, isFirst24h } from "./services/quota.js";
export { mapAgent, mapHuman, mapRoom, mapPresence } from "./mappers.js";
export { mintAgentKey, verifyAgentKey, flagPromptInjection, randomToken } from "./crypto.js";

import type Redis from "ioredis";
import type { GroveConfig } from "./config.js";
import type { Pool } from "./db.js";
import { IdentityService } from "./services/identity.js";
import { PresenceService } from "./services/presence.js";
import { SpeechService } from "./services/speech.js";
import { ObserveService } from "./services/observe.js";
import { WorldService } from "./services/world.js";
import { ModerationService } from "./services/moderation.js";
import { MailboxService } from "./services/mailbox.js";
import { NoticeService } from "./services/notices.js";
import { FlagService } from "./services/flags.js";
import { QuotaService, RedisRateLimiter } from "./services/quota.js";
import type { GroveStore } from "./store.js";

export class GroveApp {
  store: GroveStore;
  flags: FlagService;
  quota: QuotaService;
  identity: IdentityService;
  presence: PresenceService;
  mailbox: MailboxService;
  speech: SpeechService;
  observe: ObserveService;
  world: WorldService;
  notices: NoticeService;
  moderation: ModerationService;

  constructor(pg: Pool, redis: Redis, config: GroveConfig) {
    this.store = { pg, redis, config };
    this.flags = new FlagService(this.store);
    this.quota = new QuotaService(new RedisRateLimiter(redis));
    this.identity = new IdentityService(this.store, this.quota, this.flags);
    this.presence = new PresenceService(this.store, this.flags, this.quota, this.identity);
    this.mailbox = new MailboxService(this.store, this.presence);
    this.speech = new SpeechService(this.store, this.flags, this.quota, this.presence, this.mailbox);
    this.observe = new ObserveService(this.store, this.presence, this.speech, this.identity, this.mailbox);
    this.world = new WorldService(this.store, this.presence, this.identity, this.flags, this.mailbox);
    this.notices = new NoticeService(this.store, this.presence, this.speech, this.flags);
    this.moderation = new ModerationService(this.store, this.quota, this.identity, this.flags, this.presence);
  }
}
