#!/usr/bin/env bash
# Install Java (Temurin / OpenJDK).
# Any Java >= JAVA_MIN_VERSION on PATH is accepted (e.g. 23 is fine when min is 17).
# Bash 3.2 compatible (macOS system bash).
#
# Usage:
#   java.sh [min_version]          # minimum required major version
#   JAVA_MIN_VERSION=17 java.sh    # env override
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

JAVA_MIN_VERSION="${1:-${JAVA_MIN_VERSION:-17}}"
OS="$(detect_os)"

echo "☕ Java >=${JAVA_MIN_VERSION} [OS=${OS} CI=$(detect_ci)]"

# ── Check if acceptable Java is already available ─────────────────────────────
java_version_ok() {
  if ! is_installed java; then return 1; fi
  # Get major version: "17.0.1" -> 17, "1.8.0" -> 1
  local raw major
  raw="$(java -version 2>&1 | head -1 || true)"
  # Extract the number group right after 'version "'. Anchoring on the literal
  # 'version "' prefix (rather than a bare '.*"...' greedy match) is required:
  # the naive greedy pattern consumes up to the LAST quote in the line (there
  # are two — opening and closing), leaving nothing for the digit group to
  # match and silently returning an empty string.
  major="$(echo "${raw}" | sed 's/.*version "\([0-9]*\).*/\1/' || true)"
  # Handle old 1.x format (e.g. "1.8.0_292" -> 8)
  if [ "${major}" = "1" ]; then
    major="$(echo "${raw}" | sed 's/.*version "1\.\([0-9]*\).*/\1/' || true)"
  fi
  # If we couldn't parse, assume NOT ok — a failed parse must never silently
  # skip installing the explicitly requested version.
  [ -z "${major}" ] && return 1
  [ "${major}" -ge "${JAVA_MIN_VERSION}" ] 2>/dev/null
}

if java_version_ok; then
  echo "✅ Java already available (>=${JAVA_MIN_VERSION} ✓) — skipping install"
  if [ -n "${JAVA_HOME:-}" ]; then
    register_path "${JAVA_HOME}/bin"
  fi
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing Java ${JAVA_MIN_VERSION}..."

if [ "${OS}" = "macos" ]; then
  brew install --cask "temurin@${JAVA_MIN_VERSION}" \
    || brew install "openjdk@${JAVA_MIN_VERSION}" \
    || { echo "❌ brew install failed for Java ${JAVA_MIN_VERSION}" >&2; exit 1; }
  JAVA_HOME_RESOLVED="$(/usr/libexec/java_home -v "${JAVA_MIN_VERSION}" 2>/dev/null || true)"

elif [ "${OS}" = "linux" ]; then
  SUDO="$(sudo_cmd)"

  # Some base images (e.g. eclipse-temurin:*-jdk-*) bake in a JDK via an
  # absolute PATH entry like /opt/java/openjdk/bin that always comes before
  # /usr/bin — so even after apt installs a newer JDK and registers it via
  # update-alternatives at /usr/bin/java, `java`/`javac` on PATH still resolve
  # to the OLD baked-in JDK. Remember that shadowing directory now, before
  # install, so we can override it below.
  SHADOWING_JAVA_BIN_DIR=""
  if is_installed java; then
    SHADOWING_JAVA_BIN_DIR="$(dirname "$(readlink -f "$(command -v java)")" 2>/dev/null || true)"
  fi

  # JAVA_INSTALL_DIR (optional): when set, install into this directory via a
  # downloaded Adoptium tarball instead of apt/system /usr/lib/jvm. This
  # exists so CI callers can point it at a project-relative directory (e.g.
  # "$(pwd)/.jvm-cache") that a CI cache action is actually able to persist —
  # /usr/lib/jvm is OUTSIDE the job's working directory, and e.g. GitLab's
  # kubernetes-executor cache uploader silently REFUSES to archive any path
  # that isn't a subpath of the project directory (logged as "processPath:
  # artifact path is not a subpath of project directory"), so a plain apt
  # install there is re-downloaded from scratch on every single job even
  # though a cache entry is configured for it.
  JAVA_HOME_RESOLVED=""
  if [ -n "${JAVA_INSTALL_DIR:-}" ]; then
    if [ -x "${JAVA_INSTALL_DIR}/bin/java" ]; then
      JAVA_HOME_RESOLVED="${JAVA_INSTALL_DIR}"
      echo "✅ Java ${JAVA_MIN_VERSION} found at ${JAVA_HOME_RESOLVED} (cache hit) — skipping download"
    else
      echo "📥 Downloading Adoptium Temurin ${JAVA_MIN_VERSION} JDK to ${JAVA_INSTALL_DIR}..."
      mkdir -p "${JAVA_INSTALL_DIR}"
      ARCH="$(uname -m)"
      case "${ARCH}" in
        x86_64) ADOPTIUM_ARCH="x64" ;;
        aarch64|arm64) ADOPTIUM_ARCH="aarch64" ;;
        *) ADOPTIUM_ARCH="${ARCH}" ;;
      esac
      ADOPTIUM_URL="https://api.adoptium.net/v3/binary/latest/${JAVA_MIN_VERSION}/ga/linux/${ADOPTIUM_ARCH}/jdk/hotspot/normal/eclipse"
      if curl -fsSL "${ADOPTIUM_URL}" -o "/tmp/temurin-${JAVA_MIN_VERSION}.tar.gz"; then
        tar -xzf "/tmp/temurin-${JAVA_MIN_VERSION}.tar.gz" -C "${JAVA_INSTALL_DIR}" --strip-components=1
        rm -f "/tmp/temurin-${JAVA_MIN_VERSION}.tar.gz"
        JAVA_HOME_RESOLVED="${JAVA_INSTALL_DIR}"
      else
        echo "⚠️  Adoptium tarball download failed — falling back to apt/system install (won't be cached)" >&2
      fi
    fi
  fi

  # ── Fast path: a matching JDK already sits under /usr/lib/jvm, e.g.
  #    restored by the CI cache from a previous job (see .gitlab/*.yml cache
  #    paths). apt/Adoptium install is expensive (apt update + package
  #    download + optional repo/gpg-key setup); skip it entirely when the
  #    binaries are already there and just re-apply the PATH-shadowing fix
  #    below, since that fix itself never persists across fresh containers.
  if [ -z "${JAVA_HOME_RESOLVED}" ]; then
    for candidate in /usr/lib/jvm/*"${JAVA_MIN_VERSION}"*openjdk* /usr/lib/jvm/*"${JAVA_MIN_VERSION}"*temurin* /usr/lib/jvm/temurin-"${JAVA_MIN_VERSION}"*; do
      if [ -x "${candidate}/bin/java" ]; then
        JAVA_HOME_RESOLVED="${candidate}"
        break
      fi
    done
  fi

  if [ -n "${JAVA_HOME_RESOLVED}" ]; then
    echo "✅ Java ${JAVA_MIN_VERSION} found at ${JAVA_HOME_RESOLVED} (cache hit) — skipping apt/Adoptium install"
  else
    if ! ${SUDO} apt-get install -y "openjdk-${JAVA_MIN_VERSION}-jdk" -qq 2>/dev/null; then
      echo "apt fallback: adding Adoptium Temurin repo..."
      ${SUDO} apt-get install -y wget apt-transport-https gnupg -qq
      wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public \
        | ${SUDO} tee /etc/apt/trusted.gpg.d/adoptium.asc >/dev/null
      echo "deb https://packages.adoptium.net/artifactory/deb $(lsb_release -cs) main" \
        | ${SUDO} tee /etc/apt/sources.list.d/adoptium.list
      ${SUDO} apt-get update -qq
      ${SUDO} apt-get install -y "temurin-${JAVA_MIN_VERSION}-jdk" -qq
    fi

    # Locate the freshly installed JDK's home directory by glob — NOT via
    # `which java`/`command -v java`, which (per the shadowing issue above) may
    # still report the OLD baked-in JDK's path even after a successful install.
    for candidate in /usr/lib/jvm/*"${JAVA_MIN_VERSION}"*openjdk* /usr/lib/jvm/*"${JAVA_MIN_VERSION}"*temurin* /usr/lib/jvm/temurin-"${JAVA_MIN_VERSION}"*; do
      if [ -x "${candidate}/bin/java" ]; then
        JAVA_HOME_RESOLVED="${candidate}"
        break
      fi
    done
  fi

  # If a pre-existing JDK earlier on PATH shadows the one we just installed,
  # force every binary in that shadowing directory to point at the new JDK.
  # This is required because dmtools' cli_execute_command spawns a brand-new
  # subprocess for every invocation, re-inheriting the SAME original PATH each
  # time — an `export PATH=...`/`export JAVA_HOME=...` done in THIS script's
  # own process never survives to a later, independent "mvn ..." call (see
  # agents/setup/maven.sh's /usr/local/bin/mvn symlink for the same class of
  # fix). Filesystem symlinks, unlike exported env vars, persist across
  # independent subprocess invocations within the same job/container.
  if [ -n "${JAVA_HOME_RESOLVED}" ] && [ -n "${SHADOWING_JAVA_BIN_DIR}" ] \
     && [ "${SHADOWING_JAVA_BIN_DIR}" != "${JAVA_HOME_RESOLVED}/bin" ]; then
    echo "⚠️  Pre-existing Java shadows PATH at ${SHADOWING_JAVA_BIN_DIR} — overriding its binaries to point at the newly installed JDK ${JAVA_MIN_VERSION}"
    for f in "${JAVA_HOME_RESOLVED}/bin"/*; do
      ${SUDO} ln -sf "${f}" "${SHADOWING_JAVA_BIN_DIR}/$(basename "${f}")" 2>/dev/null \
        || echo "⚠️  Could not override $(basename "${f}") in ${SHADOWING_JAVA_BIN_DIR} (no write access?) — java/mvn may keep resolving to the old JDK in separate invocations."
    done
  fi

else
  echo "❌ Unsupported OS: ${OS}" >&2; exit 1
fi

if [ -n "${JAVA_HOME_RESOLVED:-}" ]; then
  export_var "JAVA_HOME" "${JAVA_HOME_RESOLVED}"
  register_path "${JAVA_HOME_RESOLVED}/bin"
fi

java -version
echo "✅ Java ${JAVA_MIN_VERSION} installed"
