from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/modules/catalog/contracts.ts",
    '''  readonly regions: readonly { readonly regionId: string; readonly active: boolean }[];
  readonly areas: readonly {
    readonly areaId: string;
    readonly regionId: string;
    readonly active: boolean;
  }[];
  readonly connections: readonly {
    readonly connectionId: string;
    readonly fromAreaId: string;
    readonly toAreaId: string;
    readonly active: boolean;
  }[];''',
    '''  readonly regions: readonly {
    readonly regionId: string;
    readonly displayName: string;
    readonly active: boolean;
    readonly data: unknown;
  }[];
  readonly areas: readonly {
    readonly areaId: string;
    readonly regionId: string;
    readonly displayName: string;
    readonly active: boolean;
    readonly data: unknown;
  }[];
  readonly connections: readonly {
    readonly connectionId: string;
    readonly connectionKey: string;
    readonly fromAreaId: string;
    readonly toAreaId: string;
    readonly accessRule: unknown;
    readonly active: boolean;
  }[];''',
)

replace_once(
    "src/modules/catalog/validation.ts",
    '''} from "./contracts.js";

export const EffectProgramSchema''',
    '''} from "./contracts.js";
import { ConnectionAccessRuleSchema, WorldAreaConfigSchema } from "./world-contracts.js";

export const EffectProgramSchema''',
)

replace_once(
    "src/modules/catalog/validation.ts",
    '''  for (const [index, area] of snapshot.areas.entries()) {
    if (!allRegionIds.has(area.regionId)) {
      issues.push(
        issue(
          "AREA_REGION_MISSING",
          `areas.${index}.regionId`,
          "Area references a region absent from this release",
        ),
      );
    }
    if (area.active && !activeRegionIds.has(area.regionId)) {
      issues.push(
        issue(
          "ACTIVE_AREA_HAS_INACTIVE_REGION",
          `areas.${index}.regionId`,
          "Active area references an inactive region",
        ),
      );
    }
  }

  for (const [index, connection] of snapshot.connections.entries()) {
    if (!allAreaIds.has(connection.fromAreaId) || !allAreaIds.has(connection.toAreaId)) {
      issues.push(
        issue(
          "CONNECTION_AREA_MISSING",
          `connections.${index}`,
          "Connection references an area absent from this release",
        ),
      );
    }
    if (
      connection.active &&
      (!activeAreaIds.has(connection.fromAreaId) || !activeAreaIds.has(connection.toAreaId))
    ) {
      issues.push(
        issue(
          "ACTIVE_CONNECTION_HAS_INACTIVE_AREA",
          `connections.${index}`,
          "Active connection references an inactive area",
        ),
      );
    }
  }''',
    '''  const areaConfigs = new Map<string, z.infer<typeof WorldAreaConfigSchema>>();
  for (const [index, area] of snapshot.areas.entries()) {
    if (!allRegionIds.has(area.regionId)) {
      issues.push(
        issue(
          "AREA_REGION_MISSING",
          `areas.${index}.regionId`,
          "Area references a region absent from this release",
        ),
      );
    }
    if (area.active && !activeRegionIds.has(area.regionId)) {
      issues.push(
        issue(
          "ACTIVE_AREA_HAS_INACTIVE_REGION",
          `areas.${index}.regionId`,
          "Active area references an inactive region",
        ),
      );
    }
    const parsedConfig = WorldAreaConfigSchema.safeParse(area.data);
    addZodIssues(issues, "AREA_WORLD_CONFIG_INVALID", `areas.${index}.data`, parsedConfig);
    if (parsedConfig.success) areaConfigs.set(area.areaId, parsedConfig.data);
  }

  for (const regionId of activeRegionIds) {
    const activeRegionAreas = snapshot.areas.filter(
      (area) => area.active && area.regionId === regionId && areaConfigs.has(area.areaId),
    );
    const startingAreas = activeRegionAreas.filter(
      (area) => areaConfigs.get(area.areaId)?.startingArea === true,
    );
    const safePoints = activeRegionAreas.filter(
      (area) => areaConfigs.get(area.areaId)?.safePoint === true,
    );
    if (startingAreas.length !== 1) {
      issues.push(
        issue(
          "REGION_STARTING_AREA_INVALID",
          `regions.${regionId}`,
          "Each active region must define exactly one active starting area",
        ),
      );
    }
    if (safePoints.length === 0) {
      issues.push(
        issue(
          "REGION_SAFE_POINT_MISSING",
          `regions.${regionId}`,
          "Each active region must define at least one active safe point",
        ),
      );
    }
  }

  for (const [index, connection] of snapshot.connections.entries()) {
    if (!allAreaIds.has(connection.fromAreaId) || !allAreaIds.has(connection.toAreaId)) {
      issues.push(
        issue(
          "CONNECTION_AREA_MISSING",
          `connections.${index}`,
          "Connection references an area absent from this release",
        ),
      );
    }
    if (
      connection.active &&
      (!activeAreaIds.has(connection.fromAreaId) || !activeAreaIds.has(connection.toAreaId))
    ) {
      issues.push(
        issue(
          "ACTIVE_CONNECTION_HAS_INACTIVE_AREA",
          `connections.${index}`,
          "Active connection references an inactive area",
        ),
      );
    }
    addZodIssues(
      issues,
      "CONNECTION_ACCESS_RULE_INVALID",
      `connections.${index}.accessRule`,
      ConnectionAccessRuleSchema.safeParse(connection.accessRule),
    );
  }''',
)

replace_once(
    "src/platform/catalog/postgres-catalog-repository.ts",
    '''      this.client.query<{ region_id: string; active: boolean }>(
        `SELECT region_id, active FROM region_revisions
         WHERE content_release_id = $1 ORDER BY region_id`,
        [releaseId],
      ),
      this.client.query<{ area_id: string; region_id: string; active: boolean }>(
        `SELECT ar.area_id, a.region_id, ar.active
         FROM area_revisions ar JOIN areas a ON a.id = ar.area_id
         WHERE ar.content_release_id = $1 ORDER BY ar.area_id`,
        [releaseId],
      ),
      this.client.query<{
        connection_id: string;
        from_area_id: string;
        to_area_id: string;
        active: boolean;
      }>(
        `SELECT acr.connection_id, ac.from_area_id, ac.to_area_id, acr.active
         FROM area_connection_revisions acr
         JOIN area_connections ac ON ac.id = acr.connection_id
         WHERE acr.content_release_id = $1 ORDER BY acr.connection_id`,
        [releaseId],
      ),''',
    '''      this.client.query<{
        region_id: string;
        display_name: string;
        active: boolean;
        data: unknown;
      }>(
        `SELECT region_id, display_name, active, data FROM region_revisions
         WHERE content_release_id = $1 ORDER BY region_id`,
        [releaseId],
      ),
      this.client.query<{
        area_id: string;
        region_id: string;
        display_name: string;
        active: boolean;
        data: unknown;
      }>(
        `SELECT ar.area_id, a.region_id, ar.display_name, ar.active, ar.data
         FROM area_revisions ar JOIN areas a ON a.id = ar.area_id
         WHERE ar.content_release_id = $1 ORDER BY ar.area_id`,
        [releaseId],
      ),
      this.client.query<{
        connection_id: string;
        connection_key: string;
        from_area_id: string;
        to_area_id: string;
        access_rule: unknown;
        active: boolean;
      }>(
        `SELECT acr.connection_id, ac.connection_key, ac.from_area_id, ac.to_area_id,
                acr.access_rule, acr.active
         FROM area_connection_revisions acr
         JOIN area_connections ac ON ac.id = acr.connection_id
         WHERE acr.content_release_id = $1 ORDER BY acr.connection_id`,
        [releaseId],
      ),''',
)

replace_once(
    "src/platform/catalog/postgres-catalog-repository.ts",
    '''      regions: regions.rows.map((entry) => ({ regionId: entry.region_id, active: entry.active })),
      areas: areas.rows.map((entry) => ({
        areaId: entry.area_id,
        regionId: entry.region_id,
        active: entry.active,
      })),
      connections: connections.rows.map((entry) => ({
        connectionId: entry.connection_id,
        fromAreaId: entry.from_area_id,
        toAreaId: entry.to_area_id,
        active: entry.active,
      })),''',
    '''      regions: regions.rows.map((entry) => ({
        regionId: entry.region_id,
        displayName: entry.display_name,
        active: entry.active,
        data: entry.data,
      })),
      areas: areas.rows.map((entry) => ({
        areaId: entry.area_id,
        regionId: entry.region_id,
        displayName: entry.display_name,
        active: entry.active,
        data: entry.data,
      })),
      connections: connections.rows.map((entry) => ({
        connectionId: entry.connection_id,
        connectionKey: entry.connection_key,
        fromAreaId: entry.from_area_id,
        toAreaId: entry.to_area_id,
        accessRule: entry.access_rule,
        active: entry.active,
      })),''',
)

replace_once(
    "tests/catalog/catalog-contracts.test.ts",
    '''    regions: [{ regionId: "region-1", active: true }],
    areas: [{ areaId: "area-1", regionId: "region-1", active: true }],
    connections: [],''',
    '''    regions: [{ regionId: "region-1", displayName: "Test Region", active: true, data: {} }],
    areas: [
      {
        areaId: "area-1",
        regionId: "region-1",
        displayName: "Test Area",
        active: true,
        data: {
          schemaVersion: 1,
          kind: "TOWN",
          safePoint: true,
          startingArea: true,
          relocationPriority: 0,
        },
      },
    ],
    connections: [],''',
)

replace_once(
    "db/seeds/phase4_vertical_slice.ts",
    '''    ["content_release_id", "area_id", "display_name"],
    [releaseId, ids.areaId, "Route 1"],''',
    '''    ["content_release_id", "area_id", "display_name", "data"],
    [
      releaseId,
      ids.areaId,
      "Route 1",
      {
        schemaVersion: 1,
        kind: "ROUTE",
        safePoint: true,
        startingArea: true,
        relocationPriority: 0,
      },
    ],''',
)

print("Phase 7 catalog world patch applied")
