#!/usr/bin/env bash
# After the push: sign the image with cosign, attest what BuildKit attached
# (SBOM, provenance) as signed in-toto attestations, and write the job
# summary. Environment: REGISTRY, IMAGE (org/repo), DIGEST, TAGS (full
# references, one per line), SIGN, ATTEST, COSIGN_PRIVATE_KEY,
# COSIGN_PASSWORD, COSIGN_ARGS, REGISTRY_URL.
set -euo pipefail

ref="$REGISTRY/$IMAGE"
subject="$ref@$DIGEST"
org="${IMAGE%%/*}"
repo="${IMAGE#*/}"

# What was pushed: the platform variants, and how many attestation entries
# (SBOM, provenance) BuildKit put into the index.
raw=$(docker buildx imagetools inspect "$subject" --raw)
media=$(jq -r '.mediaType // ""' <<< "$raw")
if [[ "$media" == *index* || "$media" == *manifest.list* ]]; then
  variants=$(jq -c '[.manifests[]
    | select((.annotations["vnd.docker.reference.type"] // "") != "attestation-manifest")
    | select((.platform.os // "") != "unknown")
    | {digest, platform: ((.platform.os // "") + "/" + (.platform.architecture // "") + (if (.platform.variant // "") != "" then "/" + .platform.variant else "" end))}]' <<< "$raw")
  buildkit_entries=$(jq '[.manifests[] | select((.annotations["vnd.docker.reference.type"] // "") == "attestation-manifest")] | length' <<< "$raw")
else
  variants=$(jq -c --arg d "$DIGEST" '[{digest: $d, platform: ""}]' <<< "$raw")
  buildkit_entries=0
fi
platforms=$(jq -r '[.[].platform | select(. != "")] | join(",")' <<< "$variants")
echo "pushed $subject (${platforms:-single platform}; $buildkit_entries BuildKit attestation entries)"

key_args=()
signer="keyless, with the job's OIDC identity"
if [[ -n "${COSIGN_PRIVATE_KEY:-}" ]]; then
  key_args=(--key env://COSIGN_PRIVATE_KEY)
  signer="with the cosign key"
fi
# shellcheck disable=SC2206
extra=(${COSIGN_ARGS:-})

signed=no
if [[ "${SIGN:-false}" == "true" ]]; then
  echo "::group::cosign sign $subject"
  cosign sign --yes --recursive ${key_args[@]+"${key_args[@]}"} ${extra[@]+"${extra[@]}"} "$subject"
  echo "::endgroup::"
  signed=yes
fi

want_sbom=false
want_provenance=false
IFS=',' read -ra kinds <<< "${ATTEST:-none}"
for k in "${kinds[@]}"; do
  case "${k// /}" in
    sbom) want_sbom=true ;;
    provenance) want_provenance=true ;;
    none | "") ;;
    *) echo "::error::attest: unknown kind '$k' (sbom, provenance or none)"; exit 1 ;;
  esac
done

# BuildKit's SBOM and provenance live in the index; `imagetools inspect`
# hands them out keyed by platform, or unkeyed for a single platform. Each
# one becomes a cosign attestation of the platform variant it describes.
attested=""
attest_kind() { # kind, imagetools field, document key, cosign predicate type
  local kind="$1" field="$2" doc_key="$3" ctype="$4" docs entries count n=0
  docs=$(docker buildx imagetools inspect "$subject" --format "{{json .$field}}" 2>/dev/null || true)
  if [[ -z "$docs" || "$docs" == "null" ]]; then
    echo "::warning::BuildKit attached no $kind to $subject; nothing to attest (is $kind switched on?)"
    return
  fi
  if jq -e "has(\"$doc_key\")" <<< "$docs" > /dev/null; then
    entries=$(jq -c --arg d "$(jq -r '.[0].digest' <<< "$variants")" "[{digest: \$d, doc: .$doc_key}]" <<< "$docs")
  else
    entries=$(jq -c --argjson v "$variants" "[to_entries[] | select(.value.$doc_key != null) | .key as \$p | {digest: (\$v[] | select(.platform == \$p) | .digest), doc: .value.$doc_key}]" <<< "$docs")
  fi
  count=$(jq 'length' <<< "$entries")
  for ((i = 0; i < count; i++)); do
    local d f t
    d=$(jq -r ".[$i].digest" <<< "$entries")
    f=$(mktemp)
    jq ".[$i].doc" <<< "$entries" > "$f"
    t="$ctype"
    if [[ "$kind" == provenance ]] && jq -e '.buildDefinition' "$f" > /dev/null; then t=slsaprovenance1; fi
    echo "::group::cosign attest --type $t $ref@$d"
    cosign attest --yes --type "$t" --predicate "$f" ${key_args[@]+"${key_args[@]}"} ${extra[@]+"${extra[@]}"} "$ref@$d"
    echo "::endgroup::"
    rm -f "$f"
    n=$((n + 1))
  done
  attested="${attested:+$attested, }$kind ($n)"
}
if [[ "$want_sbom" == true ]]; then attest_kind sbom SBOM SPDX spdxjson; fi
if [[ "$want_provenance" == true ]]; then attest_kind provenance Provenance SLSA slsaprovenance; fi

first_tag=$(head -n 1 <<< "$TAGS")
first_tag="${first_tag##*:}"
tag_list=$(sed 's/^.*://; s/^/`/; s/$/`/' <<< "$TAGS" | paste -sd ',' - | sed 's/,/, /g')
{
  echo "### Chicorée: \`$IMAGE\` pushed"
  echo
  echo "- image: \`$subject\`"
  echo "- tags: $tag_list"
  if [[ -n "$platforms" ]]; then echo "- platforms: ${platforms//,/, }"; fi
  echo "- pushed with the image: $buildkit_entries BuildKit attestation entries (SBOM, provenance)"
  if [[ "$signed" == yes ]]; then echo "- signature: cosign, $signer"; else echo "- signature: none"; fi
  echo "- signed attestations: ${attested:-none}"
  if [[ -n "${REGISTRY_URL:-}" ]]; then echo "- [open on the registry](${REGISTRY_URL%/}/$org/$repo/tags/$first_tag)"; fi
} >> "$GITHUB_STEP_SUMMARY"
{
  echo "platforms=$platforms"
  echo "signed=$signed"
  echo "attested=$attested"
} >> "$GITHUB_OUTPUT"
