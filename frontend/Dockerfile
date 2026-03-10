FROM node:20-alpine AS builder
WORKDIR /app
ARG VITE_API_URL
ARG VITE_WS_URL
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "run", "dev", "--", "--host"]

FROM nginx:1.25-alpine AS prod
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
