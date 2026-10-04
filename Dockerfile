# Itako: one Render Web Service, MongoDB Atlas + Go API + React/Vite UI.
FROM node:22-alpine AS web-build
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.25-alpine AS api-build
WORKDIR /src
COPY mongo-backend/go.mod ./mongo-backend/go.mod
RUN cd mongo-backend && go mod download
COPY mongo-backend/ ./mongo-backend/
RUN cd mongo-backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/itako-server .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=api-build /out/itako-server /app/itako-server
COPY --from=web-build /src/web/dist /app/web/dist
ENV STATIC_DIR=/app/web/dist
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/app/itako-server"]
