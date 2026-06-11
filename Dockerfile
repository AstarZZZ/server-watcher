FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
  WATCHER_HOST=0.0.0.0 \
  WATCHER_PORT=33099 \
  WATCHER_SSH_HOST=127.0.0.1 \
  WATCHER_SSH_PORT=22 \
  WATCHER_DATA_DIR=/app/data \
  WATCHER_STORAGE_ROOTS=/home \
  WATCHER_SYSTEMD_DIRS=/host/etc/systemd/system,/host/lib/systemd/system,/host/usr/lib/systemd/system

COPY --from=backend-build /app/backend/package*.json ./backend/
COPY --from=backend-build /app/backend/node_modules ./backend/node_modules
COPY --from=backend-build /app/backend/dist ./backend/dist
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/data

EXPOSE 33099
CMD ["node", "backend/dist/server.js"]
