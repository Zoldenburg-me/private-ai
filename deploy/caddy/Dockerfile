# Caddy with the in-memory rate_limit module (stock Caddy has no rate limiting).
ARG CADDY_VERSION=2.11.7
# Pinned commit of github.com/mholt/caddy-ratelimit.
ARG RATELIMIT_REF=5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:${CADDY_VERSION}-builder AS build
ARG RATELIMIT_REF
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@${RATELIMIT_REF}

FROM caddy:${CADDY_VERSION}
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
# Refuse to start without a domain (compose cannot require it without breaking the app-only stack).
CMD ["sh", "-c", "test -n \"$DOMAIN\" || { echo 'caddy: set DOMAIN in .env' >&2; exit 1; }; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
