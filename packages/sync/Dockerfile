FROM node:18-alpine

RUN apk add tini && \
    mkdir /fullstacked

COPY . /fullstacked

RUN cd /fullstacked && rm -rf package-lock.json node_modules && npm i
RUN cd /fullstacked && npm run build -- --packages sync && node prepare
RUN cd /fullstacked/packages/sync && rm -rf *.tgz package-lock.json node_modules && npm i
RUN cd /fullstacked/packages/sync/rsync && rm -rf package-lock.json node_modules && npm i
RUN cd /fullstacked && node pack --packages sync
RUN npm i -g $(find /fullstacked -name '*.tgz' -maxdepth 1)
RUN npm i -g $(find /fullstacked/packages/sync -name '*.tgz' -maxdepth 1)
RUN rm -rf /fullstacked

WORKDIR /home

EXPOSE 8080

CMD ["tini", "--", "/bin/sh", "-c", "fsc sync --server"]