export { loadConfig, isProduction, mayReturnMagicLink, type GroveConfig } from "./config.js";
export { createPool, poolUrl, sessionUrl, withTx, type Pool } from "./db.js";
export { createBus, PgRedis, sharedListener } from "./pg-redis.js";
export { migrate, pendingMigrations, schemaStatus } from "./migrate.js";
export type { SchemaStatus } from "./migrate.js";
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
export { MarkService, MARK_EVALUATE_EVERY_MS } from "./services/marks.js";
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
export { ReactionService, reactionCountsFrame } from "./services/reactions.js";
export { CardService, type CardView, type CardSource } from "./services/cards.js";
export { FollowService, type Follower, type FollowState, type FollowHooks } from "./services/follows.js";
export {
  SearchService,
  normaliseSearchQuery,
  likePattern,
  SEARCH_LIMIT,
  SEARCH_QUERY_MAX,
  ONLINE_LIMIT,
  type SearchResults,
} from "./services/search.js";
export { MessageService, type MessageActor } from "./services/messages.js";
export { AudienceService, AUDIENCE_CAP, AUDIENCE_BUCKET_SECONDS, isWatchToken } from "./services/audience.js";
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
  type ChronicleDensity,
  type ChronicleReadOptions,
} from "./services/chronicle.js";
export {
  ReplayService,
  REPLAY_MAX_WINDOW_MS,
  REPLAY_KEYFRAME_LOOKBACK_MS,
  densityBucketSeconds,
  type ReplayQuery,
  type ReplayPage,
  type ReplayKeyframeBody,
} from "./services/replay.js";
export { WebhookService, JobService } from "./services/webhooks.js";
export { HostedBrainService, type ResponsesClient, type XaiClientFactory } from "./services/brains.js";
// Cost burn (migration 024). See services/usage.ts for the three honesty rules.
export {
  UsageService,
  normaliseUsageReport,
  normaliseUsageBody,
  budgetVerdict,
  utcDay,
  MICROS_PER_USD,
  MICROS_PER_CENT,
  USAGE_MAX_REPORTS,
  DEPOSIT_WINDOW_SECONDS,
  BUDGET_NEAR_RATIO,
  type UsageReport,
  type UsageRecorded,
  type UsageTotals,
  type UsageDay,
  type AgentBudget,
  type BudgetState,
  type UsageScopeKind,
} from "./services/usage.js";
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
export { createMailer, MailSendError, type Mailer, type MailTransport } from "./mailer.js";
export {
  EmailDeliveryService,
  assessEmailHealth,
  checkSenderDns,
  fromAddress,
  type EmailHealthReport,
  type EmailHealthStatus,
  type DeliveryRow,
  type WindowStats,
} from "./services/email-deliveries.js";
// Operator overview on /mod (OPS-01): health, schema, cost, email, anomaly lines.
export {
  OpsService,
  OPS_METRICS,
  opsMetricsSql,
  detectAnomaly,
  anomaliesFor,
  metricsFromRows,
  windowsFrom,
  median,
  formatRatio,
  type AnomalyLine,
  type MetricDef,
  type MetricWindows,
  type OpsOverview,
  type CostBurn,
} from "./services/ops.js";
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
import { ReactionService } from "./services/reactions.js";
import { CardService } from "./services/cards.js";
import { FollowService } from "./services/follows.js";
import { SearchService } from "./services/search.js";
import { MessageService } from "./services/messages.js";
import { AudienceService } from "./services/audience.js";
import { ReplayService } from "./services/replay.js";
import { WebhookService, JobService } from "./services/webhooks.js";
import { HostedBrainService } from "./services/brains.js";
import { UsageService } from "./services/usage.js";
import { EmailDeliveryService } from "./services/email-deliveries.js";
import { OpsService } from "./services/ops.js";
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
  reactions: ReactionService;
  /** Working on / looking for / latest / links, for spaces and bodies (027). */
  cards: CardService;
  /** Hearts on spaces and agents, and the notices they earn (028). */
  follows: FollowService;
  /** `/` search across bodies, spaces and rooms, plus who is online (no private results). */
  search: SearchService;
  /** Leave a message: notes addressed to one person or agent (029). */
  messages: MessageService;
  /** "N watching" on the map: counted tab heartbeats, never identities. */
  audience: AudienceService;
  replay: ReplayService;
  webhooks: WebhookService;
  jobs: JobService;
  brains: HostedBrainService;
  usage: UsageService;
  emailDeliveries: EmailDeliveryService;
  /** Operator overview: health, schema drift, cost burn, email health, anomaly lines. */
  ops: OpsService;

  constructor(pg: Pool, redis: Redis, config: GroveConfig) {
    this.store = { pg, redis, config };
    this.flags = new FlagService(this.store);
    this.quota = new QuotaService(new RedisRateLimiter(redis));
    this.audience = new AudienceService(redis);
    const mailer = createMailer(config);
    // ONB-07: every magic-link send goes through the delivery ledger.
    this.emailDeliveries = new EmailDeliveryService(this.store, mailer);
    this.identity = new IdentityService(this.store, this.quota, this.flags, mailer, this.emailDeliveries);
    this.ops = new OpsService(this.store, this.emailDeliveries);
    this.presence = new PresenceService(this.store, this.flags, this.quota, this.identity);
    this.toolCalls = new ToolCallService(this.store, this.quota, this.presence);
    this.campus = new CampusService(this.store);
    this.chronicle = new ChronicleService(this.store);
    this.replay = new ReplayService(this.chronicle);
    this.webhooks = new WebhookService(this.store);
    this.jobs = new JobService(this.store);
    this.mailbox = new MailboxService(this.store, this.presence, this.webhooks);
    this.speech = new SpeechService(this.store, this.flags, this.quota, this.presence, this.mailbox, this.webhooks, this.campus);
    // Before observe: the observation packet carries the day's pin, filtered
    // for the agent asking.
    this.notices = new NoticeService(this.store, this.presence, this.speech, this.flags);
    this.cards = new CardService(this.store, this.identity, this.campus);
    // Written on the event: the three sources call back into this after their
    // own write. Late-bound because all three are built before speech/mailbox.
    this.follows = new FollowService(this.store, this.identity, this.campus, this.presence, this.speech, this.mailbox, this.quota);
    this.presence.follows = this.follows;
    this.toolCalls.follows = this.follows;
    this.campus.follows = this.follows;
    this.messages = new MessageService(this.store, this.identity, this.speech, this.mailbox, this.quota, this.flags);
    this.reactions = new ReactionService(
      this.store,
      this.chronicle,
      this.speech,
      this.presence,
      this.campus,
      this.flags,
      this.quota,
    );
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
    this.usage = new UsageService(this.store);
    this.search = new SearchService(this.store, this.campus, () => this.world.minimap());
  }
}
