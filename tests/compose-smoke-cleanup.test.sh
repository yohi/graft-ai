#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
smoke_script="${repo_root}/deploy/otel/tests/compose-smoke.test.sh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p "${tmpdir}/bin"
cat >"${tmpdir}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"${DOCKER_ARGS_LOG:?}"
EOF
chmod 700 "${tmpdir}/bin/docker"

test_removes_smoke_temp_directory() {
  local args_log override_file
  args_log="${tmpdir}/docker-args.log"

  PATH="${tmpdir}/bin:${PATH}" \
    DOCKER_ARGS_LOG="$args_log" \
    bash "$smoke_script" >/dev/null

  mapfile -t docker_args <"$args_log"
  for ((index = 0; index < ${#docker_args[@]} - 1; index += 1)); do
    if [[ "${docker_args[index]}" == '-f' && "${docker_args[index + 1]}" == */docker-compose.smoke.override.yml ]]; then
      override_file="${docker_args[index + 1]}"
      break
    fi
  done

  [[ -n "${override_file:-}" ]] || fail 'cleanup did not invoke docker compose with the override file'
  [[ ! -e "$override_file" ]] || fail 'smoke test temporary directory still exists'
}

test_removes_smoke_temp_directory
printf 'PASS: compose smoke cleanup regression test\n'
