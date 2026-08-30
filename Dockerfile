FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build

WORKDIR /app
RUN npm install --global pnpm@11.23.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY db/migrations ./db/migrations
COPY scripts/build-runtime.mjs ./scripts/build-runtime.mjs
RUN pnpm build

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS production-dependencies

WORKDIR /app
RUN npm install --global pnpm@11.23.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="pokemon-rpg-runtime" \
      org.opencontainers.image.description="Deterministic Pokemon RPG WhatsApp runtime" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json

USER node
CMD ["node", "dist/src/main.js"]
