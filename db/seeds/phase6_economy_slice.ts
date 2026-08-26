import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";
import { loadMigrations, verifyAppliedMigrations } from "../../src/platform/db/migrations.js";
import { withTransaction } from "../../src/platform/db/transaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 6 economy-slice seed");
}

const RELEASE_NO = 3n;
const RELEASE_NAME = "Phase 6 Economy Slice v1";
const EXPECTED_PARENT_RELEASE_NO = 2n;
const CURRENCY_SLUG = "pokedollar";

function unwrap<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

async function activeRelease(client: PoolClient): Promise<{ id: string; releaseNo: bigint }> {
  const result = await client.query<{ content_release_id: string; release_no: string }>(
    `SELECT pointer.content_release_id, release.release_no::text
     FROM content_release_pointers pointer
     JOIN content_releases release ON release.id = pointer.content_release_id
     WHERE pointer.pointer_key = 'ACTIVE'`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("An ACTIVE release is required before Phase 6 seed");
  return { id: row.content_release_id, releaseNo: BigInt(row.release_no) };
}

async function resolveRelease(client: PoolClient): Promise<{
  readonly id: string;
  readonly status: "DRAFT" | "VALIDATED" | "PUBLISHED";
  readonly parentReleaseNo: bigint | null;
}> {
  const result = await client.query<{
    id: string;
    status: "DRAFT" | "VALIDATED" | "PUBLISHED";
    name: string;
    parent_release_no: string | null;
  }>(
    `SELECT release.id, release.status, release.name, parent.release_no::text AS parent_release_no
     FROM content_releases release
     LEFT JOIN content_releases parent ON parent.id = release.parent_release_id
     WHERE release.release_no = $1`,
    [RELEASE_NO.toString()],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Phase 6 release was not created");
  if (row.name !== RELEASE_NAME) throw new Error("Release 3 is bound to unexpected content");
  return {
    id: row.id,
    status: row.status,
    parentReleaseNo: row.parent_release_no === null ? null : BigInt(row.parent_release_no),
  };
}

async function ensureCurrency(client: PoolClient): Promise<string> {
  await client.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, $2, 'PokéDollar', FALSE)
     ON CONFLICT (slug) DO NOTHING`,
    [randomUUID(), CURRENCY_SLUG],
  );
  const result = await client.query<{
    id: string;
    display_name: string;
    allows_negative: boolean;
  }>(
    "SELECT id, display_name, allows_negative FROM currency_definitions WHERE slug = $1",
    [CURRENCY_SLUG],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Failed to resolve Phase 6 currency");
  if (row.display_name !== "PokéDollar" || row.allows_negative) {
    throw new Error("Existing pokedollar currency differs from the canonical Phase 6 definition");
  }
  return row.id;
}

async function resolveReleaseItem(
  client: PoolClient,
  releaseId: string,
  slug: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT item.id
     FROM items item
     JOIN item_revisions revision
       ON revision.item_id = item.id
      AND revision.content_release_id = $1
      AND revision.active = TRUE
     WHERE item.slug = $2`,
    [releaseId, slug],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`Active Phase 6 item revision is missing: ${slug}`);
  return id;
}

async function seedOffers(client: PoolClient, releaseId: string, currencyId: string): Promise<void> {
  const offers = [
    ["shop.poke-ball", "poke-ball", 1n, 200n, 1],
    ["shop.potion", "potion", 1n, 300n, 2],
  ] as const;

  for (const [offerKey, itemSlug, itemQuantity, priceAmount, sortOrder] of offers) {
    const itemId = await resolveReleaseItem(client, releaseId, itemSlug);
    await client.query(
      `INSERT INTO item_purchase_offers(
         id, content_release_id, offer_key, item_id, currency_id,
         item_quantity, price_amount, sort_order, active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
       ON CONFLICT (content_release_id, offer_key) DO NOTHING`,
      [
        randomUUID(),
        releaseId,
        offerKey,
        itemId,
        currencyId,
        itemQuantity.toString(),
        priceAmount.toString(),
        sortOrder,
      ],
    );
  }
}

async function verifyOffers(client: PoolClient, releaseId: string): Promise<void> {
  const result = await client.query<{
    offer_key: string;
    item_slug: string;
    currency_slug: string;
    item_quantity: string;
    price_amount: string;
    sort_order: number;
    active: boolean;
  }>(
    `SELECT offer.offer_key, item.slug AS item_slug, currency.slug AS currency_slug,
            offer.item_quantity::text, offer.price_amount::text, offer.sort_order, offer.active
     FROM item_purchase_offers offer
     JOIN items item ON item.id = offer.item_id
     JOIN currency_definitions currency ON currency.id = offer.currency_id
     WHERE offer.content_release_id = $1
     ORDER BY offer.sort_order, offer.offer_key`,
    [releaseId],
  );
  const actual = result.rows;
  const expected = [
    {
      offer_key: "shop.poke-ball",
      item_slug: "poke-ball",
      currency_slug: CURRENCY_SLUG,
      item_quantity: "1",
      price_amount: "200",
      sort_order: 1,
      active: true,
    },
    {
      offer_key: "shop.potion",
      item_slug: "potion",
      currency_slug: CURRENCY_SLUG,
      item_quantity: "1",
      price_amount: "300",
      sort_order: 2,
      active: true,
    },
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Phase 6 offers differ from canonical seed: ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const migrations = await loadMigrations();
    const verifyClient = await pool.connect();
    try {
      await verifyAppliedMigrations(verifyClient, migrations, true);
    } finally {
      verifyClient.release();
    }

    const catalog = new CatalogService(new PostgresCatalogRepository(pool));
    const currencyId = await withTransaction(pool, ensureCurrency);

    let release = await withTransaction(pool, async (client) => {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM content_releases WHERE release_no = $1",
        [RELEASE_NO.toString()],
      );
      if (existing.rows[0] !== undefined) return resolveRelease(client);

      const parent = await activeRelease(client);
      if (parent.releaseNo !== EXPECTED_PARENT_RELEASE_NO) {
        throw new Error(
          `Phase 6 seed expects ACTIVE release ${EXPECTED_PARENT_RELEASE_NO}, got ${parent.releaseNo}`,
        );
      }
      const newReleaseId = randomUUID();
      unwrap(
        "clone Phase 5 release",
        await catalog.clonePublishedRelease({
          parentReleaseId: parent.id,
          newReleaseId,
          releaseNo: RELEASE_NO,
          name: RELEASE_NAME,
        }),
      );
      return resolveRelease(client);
    });

    if (release.parentReleaseNo !== EXPECTED_PARENT_RELEASE_NO) {
      throw new Error(
        `Phase 6 release has unexpected parent release ${String(release.parentReleaseNo)}`,
      );
    }

    if (release.status === "DRAFT") {
      await withTransaction(pool, async (client) => {
        await seedOffers(client, release.id, currencyId);
        await verifyOffers(client, release.id);
      });
      unwrap("validate Phase 6 release", await catalog.validateRelease(release.id));
      release = await withTransaction(pool, resolveRelease);
    }
    if (release.status === "VALIDATED") {
      unwrap("publish Phase 6 release", await catalog.publishRelease(release.id));
      release = await withTransaction(pool, resolveRelease);
    }
    if (release.status !== "PUBLISHED") {
      throw new Error(`Unexpected Phase 6 status: ${release.status}`);
    }

    unwrap("activate Phase 6 release", await catalog.activateRelease(release.id));
    await withTransaction(pool, async (client) => verifyOffers(client, release.id));
    console.log(`Phase 6 economy slice ready: release ${release.id}`);
  } finally {
    await pool.end();
  }
}

await main();
