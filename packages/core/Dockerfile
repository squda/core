# The scrape service, with a browser in it.
#
# Built from the repository root, because a pnpm workspace's lockfile lives
# there and an install without it is not the install that was tested:
#
#     docker build -f packages/core/Dockerfile -t squda-core .
#     docker run -p 8080:8080 --env-file .env squda-core
#
# Podman builds this identically — nothing below is specific to either runtime.
# What does differ is the host: both build for the machine they run on, so an
# image built on Apple Silicon is arm64 and an amd64 host will answer with
# `exec format error`. Pass --platform linux/amd64, or build on the platform.
#
# The base image is Playwright's own, pinned to the exact library version in
# package.json. That pin is the point: Playwright downloads a specific Chromium
# build and refuses to drive any other, so a floating tag turns into
# "Executable doesn't exist at /ms-playwright/chromium-…" on some future
# rebuild, with nothing in the diff to explain it. Bump both together or
# neither.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# The base image chooses its own Node, and the service refuses to start on
# anything below 22 — @supabase/supabase-js needs a global WebSocket that Node
# 20 does not have. Better to learn that here than from a crash loop in a log
# you have to go looking for. If this fails, try a newer image tag.
RUN node -e "if (+process.versions.node.split('.')[0] < 22) { console.error('base image ships Node ' + process.versions.node + '; this service needs 22 or newer — pick a newer playwright image tag'); process.exit(1) }"

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

# Manifests first, so a code change does not re-run the install. apps/web's
# manifest is copied but never installed: pnpm wants every workspace member the
# lockfile knows about to exist, and --filter is what keeps Next.js out of an
# image that only serves HTTP.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/schema/package.json packages/schema/
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --prod --filter @untitled/core...

COPY packages/schema packages/schema
COPY packages/core packages/core

# Chromium's own sandbox needs syscalls a hardened runtime denies, and Docker's
# 64MB /dev/shm is smaller than it wants. Set here rather than left to whoever
# deploys, because forgetting produces a launch failure on one host and a
# mid-render crash that looks like a timeout on another.
ENV CHROMIUM_ARGS="--no-sandbox,--disable-dev-shm-usage"

# Cloud Run, Render and Fly all inject PORT; this is the fallback for the ones
# that do not, and config.ts coerces whatever arrives.
ENV PORT=8080
EXPOSE 8080

# Everything below is what Lambda needs, and none of it changes the image
# anywhere else.
#
# The adapter is a Lambda extension that speaks the Runtime API on one side and
# plain HTTP to localhost on the other, so an ordinary server runs on Lambda
# unmodified. Outside Lambda it is a file in /opt/extensions that nothing ever
# executes, which is why one image can serve both.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=8080
# Without this the adapter probes / — which this service does not serve — and
# decides the app never came up.
ENV AWS_LWA_READINESS_CHECK_PATH=/health

# Lambda mounts everything read-only except /tmp, and Chromium wants somewhere
# to write: a profile directory, a crashpad database, font caches. Left to
# default it aims at $HOME and fails to launch, which surfaces as a timeout
# rather than a permissions error.
#
# Harmless off Lambda — a writable /tmp is not a thing containers lack.
ENV HOME=/tmp
ENV TMPDIR=/tmp
ENV XDG_CACHE_HOME=/tmp/.cache
ENV XDG_CONFIG_HOME=/tmp/.config

# The base image ships this user. Chromium started as root is a bigger blast
# radius than the job needs.
USER pwuser

CMD ["pnpm", "--filter", "@untitled/core", "start"]
