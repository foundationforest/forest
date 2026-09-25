# The host (host/): Bluesky's PDS at the commit in host/UPSTREAM with host/patches applied, built by
# host/build.sh and run by host/run.sh, both unchanged. The build context is the repo root.
#
# build.sh also builds upstream's test harness and installs keys/, as it does on a machine; the
# running host uses neither. run.sh reads host/pds.env, which here is empty: Railway's variables
# are the configuration (deploy/railway.ts sets them).
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /forest
COPY keys/ keys/
COPY host/ host/
RUN host/build.sh
RUN touch host/pds.env
EXPOSE 2583
CMD ["host/run.sh"]
