# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

FROM base AS prerelease
COPY --from=install /temp/prod/node_modules node_modules
COPY . .
RUN rm -f .env settings.json state.json

FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/index.ts .
COPY --from=prerelease /usr/src/app/renderer.ts .
COPY --from=prerelease /usr/src/app/types.ts .
COPY --from=prerelease /usr/src/app/constants.ts .
COPY --from=prerelease /usr/src/app/package.json .
COPY --from=prerelease /usr/src/app/assets ./assets

RUN chown -R bun:bun /usr/src/app

USER bun
ENTRYPOINT ["bun", "--smol", "run", "index.ts"]
