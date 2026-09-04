# The Paddock server (Bun) with the built SPA. The bundle is built by CI
# (bun run build) before docker build, so this image is bun + server/ +
# shared/ + src/ + dist/ and multi-arch comes for free. The server has no
# dependencies beyond Bun itself (bun:sqlite is built in).
#
# src/ is copied because the server imports a few types from src/api/types.ts;
# nothing under src/components is reached at runtime.
FROM oven/bun:1-alpine
WORKDIR /app
COPY server/ server/
COPY shared/ shared/
COPY src/ src/
COPY dist/ dist/
ENV PORT=8080 DATA_DIR=/data STATIC_DIR=/app/dist
EXPOSE 8080
VOLUME ["/data"]
CMD ["bun", "server/index.ts"]
