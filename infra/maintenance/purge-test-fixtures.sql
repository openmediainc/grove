-- Remove integration-test fixtures that leaked into the LIVE Grove world.
-- Cause: apps/api/test/integration.test.ts imports @grove/domain, which loads
-- dotenv as a side effect, so DATABASE_URL is always populated and the suite's
-- "skip without a database" guard never fires. Every run wrote real rows.
--
-- KEEPS: human `hello`; agents hello/lantern, hello/ivy, hello/claude and the
-- original pending agent; the canonical world aetheria-prime and its 6 rooms
-- plus hello's lounge. Everything else in these tables is test litter.
--
-- Run:  docker exec -i infra-postgres-1 psql -U grove -d grove -v ON_ERROR_STOP=1 \
--         -f - < infra/maintenance/purge-test-fixtures.sql
BEGIN;
CREATE TEMP TABLE keep_h AS SELECT id FROM humans WHERE handle = 'hello';
CREATE TEMP TABLE keep_a AS SELECT unnest(ARRAY[
  'agt_01M2AZDENDC37XQXPNYDMNYJXT',  -- hello/lantern
  'agt_01M2AZE1TC3K01XZ5XZ47CRZVQ',  -- hello/ivy
  'agt_01M2AZEPW6CMQXAMPP9R7F38RB',  -- stale pending ivy, harmless
  'agt_01M2BEWYB6MJ1H4FD2HESVQ6EC',  -- hello/claude
  'agt_01M2BT5MKNZEQXG1ZNM45HAFYG',  -- observer: lmstudio, awaiting claim
  'agt_01M2BT5N6CXA36KP892P5QM79J',  -- observer: edge, awaiting claim
  'agt_01M2BT5NBMVDH32FKCD2SPHNB8'   -- observer: warden, awaiting claim
]) AS id;
CREATE TEMP TABLE dh AS SELECT id FROM humans WHERE id NOT IN (SELECT id FROM keep_h);
CREATE TEMP TABLE da AS SELECT id FROM agents WHERE id NOT IN (SELECT id FROM keep_a);
-- A world is litter only if a deleted human owns it (or nobody does). A space
-- claimed by a surviving human is real product data and must be kept.
CREATE TEMP TABLE dw AS
  SELECT id FROM worlds
  WHERE id <> 'aetheria-prime'
    AND (owner_human_id IS NULL OR owner_human_id IN (SELECT id FROM dh));
CREATE TEMP TABLE dx AS SELECT id FROM dh UNION SELECT id FROM da;

SELECT (SELECT count(*) FROM dh) AS humans_removed,
       (SELECT count(*) FROM da) AS agents_removed,
       (SELECT count(*) FROM dw) AS worlds_removed;

DELETE FROM speech_deliveries WHERE recipient_id IN (SELECT id FROM dx)
   OR speech_id IN (SELECT id FROM speech WHERE sender_id IN (SELECT id FROM dx));
DELETE FROM speech WHERE sender_id IN (SELECT id FROM dx) OR target_id IN (SELECT id FROM dx);
DELETE FROM mailbox WHERE agent_id IN (SELECT id FROM da);
DELETE FROM notices WHERE author_id IN (SELECT id FROM dx);
DELETE FROM instructions WHERE agent_id IN (SELECT id FROM da) OR owner_human_id IN (SELECT id FROM dh);
DELETE FROM blocks WHERE blocker_id IN (SELECT id FROM dx) OR blocked_id IN (SELECT id FROM dx);
DELETE FROM mutes  WHERE muter_id   IN (SELECT id FROM dx) OR muted_id   IN (SELECT id FROM dx);
DELETE FROM reports WHERE reporter_id IN (SELECT id FROM dx) OR target_id IN (SELECT id FROM dx);
DELETE FROM agent_keys    WHERE agent_id IN (SELECT id FROM da);
DELETE FROM hosted_brains WHERE agent_id IN (SELECT id FROM da);
DELETE FROM agent_grants  WHERE owner_agent_id IN (SELECT id FROM da) OR counterpart_id IN (SELECT id FROM da);
DELETE FROM roles WHERE world_id IN (SELECT id FROM dw) OR holder_agent_id IN (SELECT id FROM da);
DELETE FROM stage_events WHERE world_id IN (SELECT id FROM dw) OR created_by IN (SELECT id FROM dx);
DELETE FROM world_members WHERE world_id IN (SELECT id FROM dw) OR human_id IN (SELECT id FROM dh);
DELETE FROM webhooks WHERE owner_human_id IN (SELECT id FROM dh);
UPDATE invite_codes SET redeemed_by = NULL, redeemed_at = NULL WHERE redeemed_by IN (SELECT id FROM dh);
DELETE FROM presence WHERE actor_id IN (SELECT id FROM dx);
DELETE FROM agents WHERE id IN (SELECT id FROM da);
DELETE FROM rooms  WHERE world_id IN (SELECT id FROM dw) OR owner_human_id IN (SELECT id FROM dh);
DELETE FROM worlds WHERE id IN (SELECT id FROM dw);
DELETE FROM humans WHERE id IN (SELECT id FROM dh);
COMMIT;

SELECT 'humans' t, count(*) FROM humans UNION ALL SELECT 'agents', count(*) FROM agents
UNION ALL SELECT 'rooms', count(*) FROM rooms UNION ALL SELECT 'worlds', count(*) FROM worlds
UNION ALL SELECT 'presence', count(*) FROM presence;
