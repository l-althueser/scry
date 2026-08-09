# ---- build: install deps, build the web frontend ----
FROM node:20-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm install

COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build --workspace packages/web

# ---- runtime: server + built web assets, no build tooling ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV WEB_DIST=/app/packages/web/dist

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/shared ./packages/shared
COPY --from=build /repo/packages/server ./packages/server
COPY --from=build /repo/packages/web/dist ./packages/web/dist

VOLUME ["/data"]
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "packages/server/src/index.ts"]
