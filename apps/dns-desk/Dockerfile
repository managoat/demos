# Static SPA. The bundle is built by CI (bun run build) before docker build,
# so this image is just nginx + dist/ and multi-arch comes for free.
# nginx-unprivileged runs as uid 101 with its pid and temp files under /tmp, which is what
# home-cloud's app platform asks for: a numeric non-root user and a read-only root filesystem.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/
EXPOSE 8080
