from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one anchor, found {count}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/modules/catalog/contracts.ts",
    '''  readonly starterOptions: readonly {\n    readonly regionId: string;\n    readonly formId: string;\n    readonly starterLevel: number;\n    readonly sortOrder: number;\n    readonly active: boolean;\n  }[];\n  readonly encounterTables: readonly {''',
    '''  readonly starterOptions: readonly {\n    readonly regionId: string;\n    readonly formId: string;\n    readonly starterLevel: number;\n    readonly sortOrder: number;\n    readonly active: boolean;\n  }[];\n  readonly purchaseOffers: readonly {\n    readonly offerKey: string;\n    readonly itemId: string;\n    readonly currencyId: string;\n    readonly itemQuantity: string;\n    readonly priceAmount: string;\n    readonly sortOrder: number;\n    readonly active: boolean;\n  }[];\n  readonly encounterTables: readonly {''',
)
replace_once(
    "src/modules/catalog/contracts.ts",
    '''  "starterOptions",\n] as const;''',
    '''  "starterOptions",\n  "purchaseOffers",\n] as const;''',
)

replace_once(
    "src/modules/catalog/fingerprint.ts",
    '''    starterOptions: sortByCanonical(snapshot.starterOptions),\n    encounterTables:''',
    '''    starterOptions: sortByCanonical(snapshot.starterOptions),\n    purchaseOffers: sortByCanonical(snapshot.purchaseOffers),\n    encounterTables:''',
)

replace_once(
    "src/modules/catalog/diff.ts",
    '''    starterOptions: snapshot.starterOptions.map((entry) => ({\n      key: `${entry.regionId}:${entry.formId}`,\n      value: entry,\n    })),\n    encounterTables: snapshot.encounterTables.map((entry) => ({''',
    '''    starterOptions: snapshot.starterOptions.map((entry) => ({\n      key: `${entry.regionId}:${entry.formId}`,\n      value: entry,\n    })),\n    purchaseOffers: snapshot.purchaseOffers.map((entry) => ({\n      key: entry.offerKey,\n      value: entry,\n    })),\n    encounterTables: snapshot.encounterTables.map((entry) => ({''',
)

purchase_validation = r'''  const purchaseOfferKeys = new Set<string>();
  for (const [index, offer] of snapshot.purchaseOffers.entries()) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(offer.offerKey)) {
      issues.push(
        issue(
          "PURCHASE_OFFER_KEY_INVALID",
          `purchaseOffers.${index}.offerKey`,
          "Purchase offer key has an invalid format",
        ),
      );
    }
    if (purchaseOfferKeys.has(offer.offerKey)) {
      issues.push(
        issue(
          "PURCHASE_OFFER_DUPLICATE",
          `purchaseOffers.${index}.offerKey`,
          "Purchase offer key is duplicated in this release",
        ),
      );
    }
    purchaseOfferKeys.add(offer.offerKey);

    if (!allItemIds.has(offer.itemId)) {
      issues.push(
        issue(
          "PURCHASE_OFFER_ITEM_MISSING",
          `purchaseOffers.${index}.itemId`,
          "Purchase offer references an item absent from this release",
        ),
      );
    }
    if (offer.active && !activeItemIds.has(offer.itemId)) {
      issues.push(
        issue(
          "ACTIVE_PURCHASE_OFFER_ITEM_INACTIVE",
          `purchaseOffers.${index}.itemId`,
          "Active purchase offer references an inactive item",
        ),
      );
    }

    let itemQuantity: bigint | null = null;
    let priceAmount: bigint | null = null;
    try {
      itemQuantity = BigInt(offer.itemQuantity);
      priceAmount = BigInt(offer.priceAmount);
    } catch {
      // Reported by the range validation below.
    }
    if (
      itemQuantity === null ||
      itemQuantity <= 0n ||
      priceAmount === null ||
      priceAmount < 0n ||
      !Number.isSafeInteger(offer.sortOrder) ||
      offer.sortOrder < 0
    ) {
      issues.push(
        issue(
          "PURCHASE_OFFER_RANGE_INVALID",
          `purchaseOffers.${index}`,
          "Purchase quantity must be positive, price non-negative, and sort order a non-negative safe integer",
        ),
      );
    }
  }

'''
replace_once(
    "src/modules/catalog/validation.ts",
    '''  const activeAbilityByForm = new Map<string, number>();''',
    purchase_validation + '''  const activeAbilityByForm = new Map<string, number>();''',
)

replace_once(
    "src/platform/catalog/postgres-catalog-repository.ts",
    '''      evolutions,\n      starterOptions,\n      encounterTables,''',
    '''      evolutions,\n      starterOptions,\n      purchaseOffers,\n      encounterTables,''',
)
replace_once(
    "src/platform/catalog/postgres-catalog-repository.ts",
    '''      this.client.query<{\n        region_id: string;\n        form_id: string;\n        starter_level: number;\n        sort_order: number;\n        active: boolean;\n      }>(\n        `SELECT region_id, form_id, starter_level, sort_order, active\n         FROM starter_options\n         WHERE content_release_id = $1 ORDER BY region_id, sort_order, form_id`,\n        [releaseId],\n      ),\n      this.client.query<{\n        revision_id: string;''',
    '''      this.client.query<{\n        region_id: string;\n        form_id: string;\n        starter_level: number;\n        sort_order: number;\n        active: boolean;\n      }>(\n        `SELECT region_id, form_id, starter_level, sort_order, active\n         FROM starter_options\n         WHERE content_release_id = $1 ORDER BY region_id, sort_order, form_id`,\n        [releaseId],\n      ),\n      this.client.query<{\n        offer_key: string;\n        item_id: string;\n        currency_id: string;\n        item_quantity: string;\n        price_amount: string;\n        sort_order: number;\n        active: boolean;\n      }>(\n        `SELECT offer_key, item_id, currency_id, item_quantity::text, price_amount::text,\n                sort_order, active\n         FROM item_purchase_offers\n         WHERE content_release_id = $1 ORDER BY sort_order, offer_key`,\n        [releaseId],\n      ),\n      this.client.query<{\n        revision_id: string;''',
)
replace_once(
    "src/platform/catalog/postgres-catalog-repository.ts",
    '''      starterOptions: starterOptions.rows.map((entry) => ({\n        regionId: entry.region_id,\n        formId: entry.form_id,\n        starterLevel: entry.starter_level,\n        sortOrder: entry.sort_order,\n        active: entry.active,\n      })),\n      encounterTables: tableRows,''',
    '''      starterOptions: starterOptions.rows.map((entry) => ({\n        regionId: entry.region_id,\n        formId: entry.form_id,\n        starterLevel: entry.starter_level,\n        sortOrder: entry.sort_order,\n        active: entry.active,\n      })),\n      purchaseOffers: purchaseOffers.rows.map((entry) => ({\n        offerKey: entry.offer_key,\n        itemId: entry.item_id,\n        currencyId: entry.currency_id,\n        itemQuantity: entry.item_quantity,\n        priceAmount: entry.price_amount,\n        sortOrder: entry.sort_order,\n        active: entry.active,\n      })),\n      encounterTables: tableRows,''',
)
replace_once(
    "src/platform/catalog/postgres-catalog-repository.ts",
    '''      {\n        table: "starter_options",\n        columns: ["region_id", "form_id", "starter_level", "sort_order", "active"],\n      },\n    ] as const;''',
    '''      {\n        table: "starter_options",\n        columns: ["region_id", "form_id", "starter_level", "sort_order", "active"],\n      },\n      {\n        table: "item_purchase_offers",\n        columns: [\n          "offer_key",\n          "item_id",\n          "currency_id",\n          "item_quantity",\n          "price_amount",\n          "sort_order",\n          "active",\n        ],\n      },\n    ] as const;''',
)

replace_once(
    "tests/catalog/catalog-contracts.test.ts",
    '''    starterOptions: [\n      {\n        regionId: "region-1",\n        formId: "form-1",\n        starterLevel: 5,\n        sortOrder: 1,\n        active: true,\n      },\n    ],\n    encounterTables: [''',
    '''    starterOptions: [\n      {\n        regionId: "region-1",\n        formId: "form-1",\n        starterLevel: 5,\n        sortOrder: 1,\n        active: true,\n      },\n    ],\n    purchaseOffers: [\n      {\n        offerKey: "shop.potion",\n        itemId: "item-1",\n        currencyId: "currency-1",\n        itemQuantity: "1",\n        priceAmount: "300",\n        sortOrder: 1,\n        active: true,\n      },\n    ],\n    encounterTables: [''',
)

purchase_test = r'''  it("treats purchase offers as fingerprinted, validated and diffable content", () => {
    const before = validSnapshot("release-1");
    const offer = before.purchaseOffers[0];
    expect(offer).toBeDefined();
    if (offer === undefined) return;

    const after: CatalogSnapshotWithEffects = {
      ...validSnapshot("release-2"),
      purchaseOffers: [{ ...offer, priceAmount: "350" }],
    };
    expect(fingerprintCatalog(after)).not.toBe(fingerprintCatalog(before));
    expect(
      diffCatalogSnapshots(before, after).sections.find(
        (section) => section.category === "purchaseOffers",
      ),
    ).toEqual({ category: "purchaseOffers", added: 0, removed: 0, changed: 1 });

    const invalid: CatalogSnapshotWithEffects = {
      ...before,
      purchaseOffers: [
        {
          ...offer,
          offerKey: "INVALID KEY",
          itemId: "missing-item",
          itemQuantity: "0",
          priceAmount: "-1",
        },
      ],
    };
    const report = validateCatalogSnapshot(invalid);
    expect(report.valid).toBe(false);
    expect(report.issues.some((entry) => entry.code === "PURCHASE_OFFER_KEY_INVALID")).toBe(true);
    expect(report.issues.some((entry) => entry.code === "PURCHASE_OFFER_ITEM_MISSING")).toBe(true);
    expect(report.issues.some((entry) => entry.code === "PURCHASE_OFFER_RANGE_INVALID")).toBe(true);
  });

'''
replace_once(
    "tests/catalog/catalog-contracts.test.ts",
    '''  it("produces a readable release diff without changing historical snapshots", () => {''',
    purchase_test + '''  it("produces a readable release diff without changing historical snapshots", () => {''',
)

print("Phase 6 catalog purchase-offer patch staged successfully")
