# One process: Bun serves the built SPA and the /gh endpoints that need the
# GitHub App's secrets. No nginx, nothing to supervise, and the API is
# same-origin with the page so there is no CORS to get wrong.
#
# The bundle is built by CI before docker build, and the server is plain
# TypeScript that Bun runs directly. It needs no dependencies at runtime.
FROM oven/bun:1-alpine
WORKDIR /app
COPY server/ ./server/
COPY dist/ ./dist/
USER bun
EXPOSE 8080
CMD ["bun", "server/index.ts"]
