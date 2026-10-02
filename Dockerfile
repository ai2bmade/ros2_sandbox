# ---- build the front end ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- run: Node server (static files + COOP/COEP headers + API) ----
FROM node:22-alpine
ENV NODE_ENV=production PORT=80 DIST_DIR=/app/dist
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/*.js ./
COPY --from=build /app/dist /app/dist
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1/api/health || exit 1
CMD ["node", "index.js"]
