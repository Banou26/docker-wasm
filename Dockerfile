FROM golang:1.23-alpine

RUN apk add --no-cache make

COPY src/proxy /build/src/proxy
COPY Makefile /build/Makefile

WORKDIR /build

RUN make
