# SignalFold per-job egress proxy image.
#
# A dependency-free Node TLS-intercepting forward proxy (docker/egress-proxy/
# proxy.mjs) — the ONLY route to the internet for a network-skill container. It
# bakes the per-deployment egress CA + pre-minted per-host leaf certs (made by
# docker/egress-proxy/gen-certs.sh into docker/.egress-certs, gitignored). The CA
# *key* lives only here and on the host; the network-skill image trusts ca.crt
# alone, so the proxy is the sole party that can answer for an allowlisted host.
#
# Build:  ai-sidecar/run.sh egress-build   (generates certs first, then builds)
FROM node:22-slim

WORKDIR /opt/egress
# Pre-minted CA + per-host leaf certs (SNI selects the leaf at handshake time).
COPY docker/.egress-certs /opt/egress-certs
COPY docker/egress-proxy/proxy.mjs /opt/egress/proxy.mjs
ENV EGRESS_CERT_DIR=/opt/egress-certs

# Driven per job: the host starts this container on the per-job --internal bridge
# and passes EGRESS_ALLOWLIST (the job's approved host subset), the caps, and
# EGRESS_AUDIT_LOG (a mounted file the receipt folds in). No long-running state.
CMD ["node", "/opt/egress/proxy.mjs"]
