FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download all
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -mod=mod -ldflags="-s -w" -o netmap-agent .

FROM alpine:3.19
RUN apk add --no-cache iproute2 net-tools samba-client
COPY --from=builder /app/netmap-agent /usr/local/bin/
ENTRYPOINT ["netmap-agent"]
