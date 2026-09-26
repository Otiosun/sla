# Bell — Headless Narrator/PVE UAT

This proof is deliberately socket-free. It exercises the real normalized Baileys ingress boundary,
MessagingService, MessageRouter/policies, PostgreSQL repositories, domain services, durable Outbox,
and a fake WhatsApp transport.

Covered lifecycle:

- LID → canonical WhatsApp JID normalization for mentions and player ingress.
- Narrator `/spawn @treinador 2` through the real command policy.
- One canonical Encounter with two frozen wild slots.
- Duplicate inbound replay without duplicate Encounter/outbox delivery.
- Narrator `/iniciarbatalha @treinador`.
- Real persisted wild Battle with two opponent roster members.
- Player `/capturar` using a human Ball name/discovery path; deterministic UAT Ball probability.
- Partial capture marks only wild #1 captured and keeps Battle/Encounter active on wild #2.
- Logical service recreation from the same PostgreSQL state.
- Player `/fugir` terminates Battle and Encounter.
- Durable Outbox is delivered through a fake transport only.
- Player-facing replies are checked for UUID leakage.

No real WhatsApp network, QR, socket, or human UAT is required by this proof.

- The multi-wild capture step uses `/capturar 1`, matching the player-facing human target number contract.

- The capture step follows the bot's real compact prompt: `/capturar Poké Ball`.

- Channel isolation: the WhatsApp Outbox worker claims only `whatsapp` messages; `INTERNAL` capture events remain durable and pending for their dedicated consumer instead of being falsely failed as an unavailable WhatsApp channel.
