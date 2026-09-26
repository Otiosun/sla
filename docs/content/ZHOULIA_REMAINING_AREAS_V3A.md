# Zhoulia Remaining Authored Areas V3A

This tranche extends the typed Zhoulia bundle and PostgreSQL DRAFT structure from the first Vila dos Arrozais → Campos de Yun vertical to all six authored areas currently supplied.

Added as typed/DRAFT areas:

- Floresta de Sekigloom / Mil Bambu
- Cidade do Aquário
- Porto dos Céus
- Templo do Céu Antigo

The source facts are preserved conservatively:

- Floresta de Sekigloom / Mil Bambu keeps the Sekigloom / Sekizor / Mil Bambu naming inconsistency instead of silently normalizing it, and preserves the authored night/spectral references as editorial metadata.
- Cidade do Aquário keeps its coastal/deep-water identity and Ginásio das Marés. The source mentions urban, water, submerged and rare encounter groupings, but no species list was supplied here, so no mechanical encounter table is invented.
- Porto dos Céus keeps the bay/mountains/islands/Flying theme. No gym is added because none was supplied.
- Templo do Céu Antigo keeps the mountain Dragon-pact theme, the Dragonite/Salamence/Flygon/Altaria source mentions, and the sky-serpent resemblance to Rayquaza strictly as a mystery rather than an identity claim.

No additional routes are created because the supplied material does not define enough canonical connections between these four areas and the Vila/Yun vertical.

No numeric DAY/NIGHT clock ranges are introduced. Existing semantic DAY/NIGHT runtime handling remains unchanged.

The seven mechanically materialized encounter tables remain the authored Vila/Yun tables only. The new areas are imported into DRAFT with presentation metadata, but encounter tables stay absent until canonical species/pool details and explicit balance policy are available.
