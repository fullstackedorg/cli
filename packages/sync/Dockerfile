FROM node:18-alpine

RUN apk add tini && \
    mkdir /fullstacked

COPY fullstacked-cli-*.tgz /fullstacked/cli.tgz
COPY packages/sync/fullstacked-sync-*.tgz /fullstacked/sync.tgz

RUN npm i -g /fullstacked/cli.tgz
RUN npm i -g /fullstacked/sync.tgz

WORKDIR /home

EXPOSE 8080

CMD ["tini", "--", "/bin/sh", "-c", "fsc sync --server"]