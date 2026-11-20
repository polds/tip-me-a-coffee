# The Node build of the tip jar, for Google Cloud Run or any container host.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# dist/ is self-contained: the server bundle and the browser bundles, with no node_modules.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
USER node
# Cloud Run sets PORT. Elsewhere the server listens on 8787.
CMD ["node", "dist/node.js"]
