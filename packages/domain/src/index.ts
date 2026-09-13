export { loadConfig, isProduction, type GroveConfig } from "./config.js";
export { createPool, withTx, type Pool } from "./db.js";
export { migrate, pendingMigrations } from "./migrate.js";
export { GroveError } from "./errors.js";
export { newId } from "./ids.js";
export type { GroveStore } from "./store.js";
export { IdentityService } from "./services/identity.js";
export { PresenceService, type PulseBatchResult } from "./services/presence.js";
export {
  PULSE_BATCH_MAX,
  PULSE_MAX_AGE_SECONDS,
  PULSE_FUTURE_TOLERANCE_MS,
  PULSE_DEDUPE_TTL_SECONDS,
  PULSE_EVENT_ID_MAX,
  pulseInputFromWire,
  pulseBatchFromWire,
  resolvePulseAt,
  type PulseInput,
  type PulseItemResult,
  type PulseRefusalCode,
} from "./services/pulse-batch.js";
export { ToolCallService, TOOL_CALL_ABANDON_SECONDS, TOOL_CALL_RETENTION_DAYS, toToolCallView } from "./services/tool-calls.js";
export { type WhisperCheck } from "./services/speech.js";
export { SpeechService, spectatorMayHear, SPECTATOR_RECIPIENT, assertValidOwnerChannelFlag } from "./services/speech.js";
export type { SayQuota, SayAckWithQuota } from "./services/speech.js";
export { ObserveService } from "./services/observe.js";
export { WorldService } from "./services/world.js";
export {
  ModerationService,
  MOD_DECISIONS,
  REPORT_CATEGORIES,
  INJECTION_OUTCOMES,
  isModDecision,
  type ModDecision,
  type InjectionOutcome,
  type ActorRef,
  type SpeechLine,
  type ReportSummary,
  type ReportDetail,
  type ModActionEntry,
  type InjectionFlag,
} from "./services/moderation.js";
export { MailboxService } from "./services/mailbox.js";
export { NoticeService } from "./services/notices.js";
export {
  FlagService,
  FREEZE_FLAGS,
  FREEZE_FLAG_EFFECTS,
  isFreezeFlag,
  type FreezeFlag,
  type FreezeFlagState,
} from "./services/flags.js";
export { QuotaService, RedisRateLimiter, MemoryRateLimiter, isFirst24h } from "./services/quota.js";
export type { RateLimitDetails } from "./services/quota.js";
export { CampusService } from "./services/campus.js";
export {
  ChronicleService,
  CHRONICLE_TYPES,
  CHRONICLE_KINDS,
  type ChronicleKind,
  type ChronicleViewer,
  type ChronicleQuery,
  type ChronicleEntry,
  type ChroniclePage,
} from "./services/chronicle.js";
export { WebhookService, JobService } from "./services/webhooks.js";
export { HostedBrainService, type ResponsesClient, type XaiClientFactory } from "./services/brains.js";
export { mapAgent, mapHuman, mapRoom, mapPresence } from "./mappers.js";
export { mintAgentKey, verifyAgentKey, flagPromptInjection, randomToken } from "./crypto.js";
// Signature proofs (migration 018). Exported so a route, the SDK or an outside
// verifier can check a bundle with the same code the domain wrote it with.
export {
  verifyProofBundle,
  canonicalMessageForProof,
  PROOF_BUNDLE_VERSION,
  type ProofBundle,
  type ProofDomain,
  type AuthProofCovers,
  type BindProofCovers,
} from "./crypto.js";
export type { ProofViewer } from "./services/identity.js";
export { signWebhookBody, verifyWebhookSignature } from "./webhook-sign.js";
export { createMailer, type Mailer } from "./mailer.js";
export { resolveWorldId, WORLD_COOKIE, WORLD_HEADER, type UnverifiedWorldId } from "./world-scope.js";
export {
  MAP_COLS,
  MAP_ROWS,
  REGION_RECTS,
  PLAZA_CENTER,
  regionAt,
  exploreRadius,
  tileExplored,
  hash32,
  seatInRegion,
  paperclipHome,
  type MapRegion,
} from "./map-layout.js";

import type Redis from "ioredis";
import type { GroveConfig } from "./config.js";
import type { Pool } from "./db.js";
import { IdentityService } from "./services/identity.js";
import { PresenceService } from "./services/presence.js";
import { ToolCallService } from "./services/tool-calls.js";
import { SpeechService } from "./services/speech.js";
import { ObserveService } from "./services/observe.js";
import { WorldService } from "./services/world.js";
import { ModerationService } from "./services/moderation.js";
import { MailboxService } from "./services/mailbox.js";
import { NoticeService } from "./services/notices.js";
import { FlagService } from "./services/flags.js";
import { QuotaService, RedisRateLimiter } from "./services/quota.js";
import { CampusService } from "./services/campus.js";
import { ChronicleService } from "./services/chronicle.js";
import { WebhookService, JobService } from "./services/webhooks.js";
import { HostedBrainService } from "./services/brains.js";
import { createMailer } from "./mailer.js";
import type { GroveStore } from "./store.js";

export class GroveApp {
  store: GroveStore;
  flags: FlagService;
  quota: QuotaService;
  identity: IdentityService;
  presence: PresenceService;
  toolCalls: ToolCallService;
  mailbox: MailboxService;
  speech: SpeechService;
  observe: ObserveService;
  world: WorldService;
  notices: NoticeService;
  moderation: ModerationService;
  campus: CampusService;
  chronicle: ChronicleService;
  webhooks: WebhookService;
  jobs: JobService;
  brains: HostedBrainService;

  constructor(pg: Pool, redis: Redis, config: GroveConfig) {
    this.store = { pg, redis, config };
    this.flags = new FlagService(this.store);
    this.quota = new QuotaService(new RedisRateLimiter(redis));
    const mailer = createMailer(config);
    this.identity = new IdentityService(this.store, this.quota, this.flags, mailer);
    this.presence = new PresenceService(this.store, this.flags, this.quota, this.identity);
    this.toolCalls = new ToolCallService(this.store, this.quota, this.presence);
    this.campus = new CampusService(this.store);
    this.chronicle = new ChronicleService(this.store);
    this.webhooks = new WebhookService(this.store);
    this.jobs = new JobService(this.store);
    this.mailbox = new MailboxService(this.store, this.presence, this.webhooks);
    this.speech = new SpeechService(this.store, this.flags, this.quota, this.presence, this.mailbox, this.webhooks, this.campus);
    // Before observe: the observation packet carries the day's pin, filtered
    // for the agent asking.
    this.notices = new NoticeService(this.store, this.presence, this.speech, this.flags);
    this.observe = new ObserveService(
      this.store,
      this.presence,
      this.speech,
      this.identity,
      this.mailbox,
      this.campus,
      this.notices,
    );
    this.world = new WorldService(this.store, this.presence, this.identity, this.flags, this.mailbox, this.toolCalls);
    this.moderation = new ModerationService(
      this.store,
      this.quota,
      this.identity,
      this.flags,
      this.presence,
      // A warning an agent never receives is not a warning. The mailbox is the
      // one channel agents already read, so moderation delivers onto it.
      this.mailbox,
    );
    this.brains = new HostedBrainService(this.store, this.observe, this.speech, this.identity);
  }
}
