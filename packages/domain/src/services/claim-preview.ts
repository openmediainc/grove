import {
  plotNeighbourhood,
  readStoredBranding,
  redactNeighbour,
  ringForPlotIndex,
  type ClaimPreview,
  type Human,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import type { CampusService } from "./campus.js";
import type { QuotaService } from "./quota.js";

/**
 * Preview before claiming (queue #48). READ-ONLY by construction: two SELECTs,
 * no writes, no hold on the plot. Signed-in and metered, and it returns only
 * what the public minimap already publishes about the neighbouring plots
 * (redactNeighbour drops a private plot to "held"), plus the computed index.
 */
export class ClaimPreviewService {
  constructor(
    private store: GroveStore,
    private campus: CampusService,
    private quota: QuotaService,
  ) {}

  async preview(human: Human): Promise<ClaimPreview> {
    await this.quota.consumeClaimPreview(human.id);
    return this.compute();
  }

  /** The unmetered read, for tests and for create's re-check. */
  async compute(): Promise<ClaimPreview> {
    const plotIndex = await this.campus.nextPlotIndex();
    const { rows: held } = await this.store.pg.query<{ plot_index: string | number }>(
      `SELECT plot_index FROM worlds WHERE plot_index IS NOT NULL AND archived_at IS NULL`,
    );
    const near = plotNeighbourhood(
      plotIndex,
      held.map((r) => Number(r.plot_index)),
    );
    if (!near.length) return { plotIndex, ring: ringForPlotIndex(plotIndex), neighbours: [] };
    // Name, orgs and branding are selected for public plots only: a private
    // plot's never leave the database, rather than being dropped afterwards.
    const { rows } = await this.store.pg.query(
      `SELECT w.plot_index, w.policy_preset,
              CASE WHEN w.policy_preset = 'private' THEN NULL ELSE w.name END AS name,
              CASE WHEN w.policy_preset = 'private' THEN NULL ELSE w.branding END AS branding,
              CASE WHEN w.policy_preset = 'private' THEN '[]'::json ELSE
                COALESCE((SELECT json_agg(json_build_object('name', o.name, 'colour', o.colour)
                                          ORDER BY wo.created_at, o.id)
                            FROM world_orgs wo JOIN orgs o ON o.id = wo.org_id
                           WHERE wo.world_id = w.id), '[]'::json) END AS orgs
         FROM worlds w
        WHERE w.plot_index = ANY($1::int[]) AND w.archived_at IS NULL
        ORDER BY w.plot_index`,
      [near],
    );
    return {
      plotIndex,
      ring: ringForPlotIndex(plotIndex),
      neighbours: rows.map((r) =>
        redactNeighbour({
          plotIndex: Number(r.plot_index),
          policyPreset: String(r.policy_preset),
          name: r.name == null ? null : String(r.name),
          orgs: (r.orgs as Array<{ name: string; colour: string }> | null) ?? [],
          branding: readStoredBranding(r.branding),
        }),
      ),
    };
  }
}
