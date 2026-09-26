# The carrier's relay (carrier/): indigo's cmd/relay at the commit in carrier/UPSTREAM, built by
# carrier/build.sh unchanged. build.sh also builds Jetstream; only the relay is shipped, because the
# foundation's index reads the relay's own stream (carrier/README.md). The build context is the repo
# root. Every setting is a Railway variable (deploy/railway.ts), as carrier/relay.env.example lists them.
FROM golang:1.26-bookworm AS build
WORKDIR /forest
COPY carrier/ carrier/
RUN carrier/build.sh

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /forest/carrier/bin/relay /usr/local/bin/relay
EXPOSE 2470
# The volume is mounted at /data when the container starts; the relay's folders are made on it then.
CMD ["sh", "-c", "mkdir -p /data/relay/persist && exec relay serve"]
