#!/usr/bin/env bash
# Mint a per-deployment egress CA + one leaf cert (CN + SAN = host) for every host
# in the allowlist superset. The egress proxy presents these leaves (selected by
# SNI) when it terminates TLS; the network-skill image trusts ONLY this CA, so the
# proxy is the sole party that can answer for an allowlisted host. The CA *key*
# stays here (gitignored) and in the proxy image; the network image gets ca.crt
# only. Idempotent: re-mints nothing if ca.crt already exists.
set -euo pipefail
HOSTS_FILE="${1:?usage: gen-certs.sh <hosts-file> <out-dir>}"
OUT="${2:?usage: gen-certs.sh <hosts-file> <out-dir>}"

if [[ -f "$OUT/ca.crt" && -f "$OUT/ca.key" ]]; then
  echo "egress certs already present in $OUT ($(ls "$OUT"/*.crt 2>/dev/null | grep -vc ca.crt) leaf cert(s)) — leaving as-is"
  exit 0
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl not found — cannot mint egress certs" >&2; exit 1; }
mkdir -p "$OUT"

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$OUT/ca.key" -out "$OUT/ca.crt" \
  -subj "/CN=SignalFold Egress CA (local)" >/dev/null 2>&1
chmod 600 "$OUT/ca.key"

count=0
while IFS= read -r host || [[ -n "$host" ]]; do
  host="$(echo "$host" | tr -d '[:space:]')"
  [[ -z "$host" ]] && continue
  openssl req -newkey rsa:2048 -nodes -keyout "$OUT/$host.key" -out "/tmp/$host.csr" -subj "/CN=$host" >/dev/null 2>&1
  openssl x509 -req -in "/tmp/$host.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
    -out "$OUT/$host.crt" -days 3650 \
    -extfile <(printf "subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" "$host") >/dev/null 2>&1
  rm -f "/tmp/$host.csr"
  count=$((count + 1))
done < "$HOSTS_FILE"
rm -f "$OUT/ca.srl"
echo "minted egress CA + $count leaf cert(s) into $OUT"
