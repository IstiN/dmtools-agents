#!/usr/bin/env bash
# Fails with a clear message if any of the given environment variable names are
# unset or empty. Used as a "hard prerequisite" setup-command gate so that
# cli_execute_command (whose validateNoShellInjection() rejects any command
# string containing &&, ||, ;, |, $(...), ${...}) can invoke a single simple
# "bash check_required_env_vars.sh VAR1 VAR2 ..." call — all the actual
# conditional logic lives here in the script file, which is NOT subject to
# that shell-metacharacter restriction.
#
# Usage:
#   bash check_required_env_vars.sh MAVEN_USER MAVEN_PASSWORD
set -u

MISSING=()
for name in "$@"; do
  value="${!name:-}"
  if [ -z "${value}" ]; then
    MISSING+=("${name}")
  fi
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "❌ Missing required environment variable(s): ${MISSING[*]}"
  echo "   Add them as protected + masked CI/CD variables on this GitLab project"
  echo "   (Settings → CI/CD → Variables), then re-run this pipeline."
  exit 1
fi

echo "✅ All required environment variables are set: $*"
