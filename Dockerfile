FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --from=build --chown=node:node /app/public ./public

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "server.js"]
