FROM golang:1.22-alpine AS builder
RUN apk add --no-cache libpcap-dev gcc musl-dev git
WORKDIR /app
COPY go.mod ./
RUN go mod download all
COPY . .
RUN CGO_ENABLED=1 go build -mod=mod -ldflags="-s -w" -o netmap-scanner .

FROM alpine:3.19
RUN apk add --no-cache nmap nmap-scripts libpcap
COPY --from=builder /app/netmap-scanner /usr/local/bin/
ENTRYPOINT ["netmap-scanner"]
