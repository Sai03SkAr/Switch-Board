# Single image for the whole monorepo — apps/api, apps/mcp, and the db migrate/seed
# scripts all run from it via CMD/entrypoint overrides in docker-compose.yml, the same
# way `npx tsx <entry>` runs each of them locally. No separate build step: this project
# has no compiled JS output configured (everything runs directly via tsx, in dev and
# here), so introducing one just for Docker would be a second, divergent way of running
# the same code — exactly what plan/07-roadmap.md's "don't gold-plate" discipline argues
# against.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/mcp/package.json apps/mcp/
COPY apps/cli/package.json apps/cli/

RUN npm ci

COPY . .

EXPOSE 3000 3001

CMD ["npx", "tsx", "apps/api/src/server.ts"]
