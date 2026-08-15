#!/usr/bin/env bash
#
# Replace the running service with a specific image.
#
#     ec2-deploy.sh <image-uri>
#
# Runs on the instance, sent there by the GitHub workflow through SSM. Kept in
# the repository rather than on the box so that how a deploy happens is visible
# in the diff, and so a change to it is reviewed like any other.
#
# Pinned to a digest-or-sha tag, never `latest`: two deploys of `latest` are
# indistinguishable afterwards, and the first question when something breaks is
# always "which build is actually running?".
set -euo pipefail

IMAGE="${1:?usage: ec2-deploy.sh <image-uri>}"
REGISTRY="${IMAGE%%/*}"
CONTAINER=squda
ENV_FILE=/opt/squda.env

# The instance profile grants ECR read; this exchanges it for a docker login.
aws ecr get-login-password --region "${AWS_REGION:-ap-south-1}" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# Pulled before the old container is touched. A failed pull then leaves the
# running service exactly as it was, rather than stopping it and discovering
# there is nothing to start.
docker pull "$IMAGE"

docker rm -f "$CONTAINER" 2>/dev/null || true

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p 80:8080 \
  --env-file "$ENV_FILE" \
  "$IMAGE"

# The disk is 20GB and each image is ~3GB, so untagged layers from previous
# deploys are what eventually fills it. Cheap to do here, and the failure it
# prevents — a pull dying halfway with "no space left on device" — reads like a
# Docker problem rather than a housekeeping one.
docker image prune -f >/dev/null

# Give it a moment, then prove it is actually serving rather than merely
# started. A container that crashes on boot still reports "Up" for a second or
# two, and a deploy that reports success on that is worse than one that fails.
sleep 5
curl -fsS --max-time 10 http://localhost/health > /dev/null

echo "deployed $IMAGE"
docker ps --filter "name=$CONTAINER" --format '{{.Image}}  {{.Status}}'
