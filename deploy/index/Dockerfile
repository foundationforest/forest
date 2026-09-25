# The index (index/): its readers and its pages. The build context is the repo root, because the
# index imports shapes/, registry/client and escrow/client by relative path (index/HOSTING.md);
# the install line is HOSTING.md's. The devnet opinions (which issuer counts, which tokens are money)
# are deploy/index/*.devnet.json, named by the variables below.
FROM node:22.22.2-bookworm-slim
WORKDIR /forest
COPY shapes/ shapes/
COPY registry/client/ registry/client/
COPY escrow/client/ escrow/client/
COPY index/ index/
COPY deploy/index/ deploy/index/
RUN (cd shapes && npm ci --no-audit --no-fund) \
  && (cd registry/client && npm ci --no-audit --no-fund) \
  && (cd escrow/client && npm ci --no-audit --no-fund) \
  && (cd index && npm ci --no-audit --no-fund)
ENV ISSUERS_FILE=/forest/deploy/index/issuers.devnet.json \
    CURRENCIES_FILE=/forest/deploy/index/currencies.devnet.json \
    SCORING_FILE=/forest/deploy/index/scoring.devnet.json
WORKDIR /forest/index
# Readers and pages in one process: the Railway trial allows five services, and this makes five.
# Split, the readers run `node src/main.ts readers` and the pages `node src/main.ts web`.
CMD ["node", "src/main.ts"]
