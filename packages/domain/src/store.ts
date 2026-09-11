import type { Redis } from "ioredis";
import type { Pool } from "./db.js";
import type { GroveConfig } from "./config.js";

export interface GroveStore {
  pg: Pool;
  redis: Redis;
  config: GroveConfig;
}
