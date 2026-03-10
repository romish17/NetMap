FROM node:20-alpine AS base
WORKDIR /app

FROM base AS dev
COPY package*.json ./
RUN npm install
COPY src ./src
CMD ["node", "--watch", "src/index.js"]

FROM base AS builder
COPY package*.json ./
RUN npm install --omit=dev

FROM base AS prod
COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "src/index.js"]
