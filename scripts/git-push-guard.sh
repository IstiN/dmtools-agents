#!/usr/bin/env bash
# git-push-guard — mechanical guard for agent sessions (dmtools-agents#542).
#
# Installed as a `git` shim at the FRONT of PATH for every agent session (see
# scripts/run-agent.sh and the "Run agent" step of
# .github/workflows/factory-teammate.yml). Because PATH is inherited by the
# provider CLI (fa/claude/cursor/…) and by `dmtools run` (whose
# cli_execute_command resolves `git` via PATH), this shim interposes on BOTH
# push paths: the LLM agent's own shell tool and the JS pre/post-actions.
#
# RCA: 2026-09-26/27 night, machine loop gh-992 (IstiN/flutter_agent_harness):
# a rework agent leg crafted a commit tagged "(closes #992)" and pushed it
# DIRECTLY to main (fa 8411523), bypassing PR + validation. Post-action
# guards only cover pushes the post-action performs; the agent's own
# `git push` went straight past them. This shim makes such pushes impossible
# inside an agent session, independent of prompt compliance.
#
# Rules (canonical logic: js/common/gitPushGuard.js — kept in sync, pinned by
# js/unit-tests/test_gitPushGuard.js):
#   1. Any `git push` whose target is a protected branch (main, master, the
#      remote default branch from origin/HEAD, or anything in
#      FA_GIT_GUARD_PROTECTED_BRANCHES) is REFUSED. Covers:
#        git push origin main          git push origin HEAD:main
#        git push origin :main         git push origin --delete main
#        git push            (while a protected branch is checked out)
#        git push --all / --mirror     (refused outright in agent sessions)
#   2. Any `git commit` whose message contains a GitHub closing keyword
#      (closes/fixes/resolves #N, owner/repo#N, or an issue URL) is REFUSED —
#      closing keywords belong to the PR body (squash-merge message), never
#      to an agent commit message.
#
# Env:
#   FA_GIT_GUARD_PROTECTED_BRANCHES   comma/space list of extra protected branches
#   FA_GIT_GUARD_ALLOW_CLOSING_KEYWORDS=1   skip rule 2
#   FA_GIT_GUARD_OFF=1                      bypass entirely (operator escape hatch)

# Deliberately NOT set -u/-e: this shim must never kill an unrelated git
# invocation because of its own bookkeeping bug — guard failures exit 2
# explicitly, everything else falls through to real git.

# ── Resolve the REAL git (skip ourselves, wherever we sit on PATH) ──────────
_self_resolved="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
_real_git=""
_save_ifs="$IFS"; IFS=:
# shellcheck disable=SC2086
for _dir in $PATH; do
    IFS="$_save_ifs"
    [ -n "$_dir" ] || continue
    _cand="$_dir/git"
    [ -x "$_cand" ] || continue
    _cand_resolved="$(readlink -f "$_cand" 2>/dev/null || printf '%s' "$_cand")"
    if [ "$_cand_resolved" != "$_self_resolved" ]; then
        _real_git="$_cand"
        break
    fi
done
IFS="$_save_ifs"
if [ -z "$_real_git" ]; then
    for _cand in /usr/bin/git /usr/local/bin/git /opt/homebrew/bin/git; do
        if [ -x "$_cand" ]; then _real_git="$_cand"; break; fi
    done
fi
if [ -z "$_real_git" ]; then
    echo "git-push-guard: cannot locate real git on PATH" >&2
    exit 127
fi

if [ "${FA_GIT_GUARD_OFF:-0}" = "1" ]; then
    exec "$_real_git" "$@"
fi

# ── Extract the subcommand, skipping git's global options ───────────────────
_subcmd=""
_subi=0
_args=("$@")
_n=${#_args[@]}
while [ "$_subi" -lt "$_n" ]; do
    _a="${_args[$_subi]}"
    case "$_a" in
        -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)
            _subi=$((_subi + 2));;
        -*)
            _subi=$((_subi + 1));;
        *)
            _subcmd="$_a"
            _subi=$((_subi + 1))
            break;;
    esac
done
_rest=("${_args[@]:$_subi}")

case "$_subcmd" in
    push|commit) ;;
    *) exec "$_real_git" "$@" ;;
esac

# ── Protected-branch set ────────────────────────────────────────────────────
_protected=" main master "
_extra="${FA_GIT_GUARD_PROTECTED_BRANCHES:-}"
if [ -n "$_extra" ]; then
    _old_ifs="$IFS"; IFS=', '
    for _b in $_extra; do
        _b="${_b#refs/heads/}"; _b="${_b#origin/}"
        [ -n "$_b" ] && case "$_protected" in *" $_b "*) ;; *) _protected="$_protected$_b ";; esac
    done
    IFS="$_old_ifs"
fi
# Remote default branch (origin/HEAD → refs/remotes/origin/main).
_default_ref="$("$_real_git" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
if [ -n "$_default_ref" ]; then
    _default_branch="${_default_ref#origin/}"
    case "$_protected" in *" $_default_branch "*) ;; *) _protected="$_protected$_default_branch ";; esac
fi

_is_protected() {
    case "$_protected" in *" $1 "*) return 0;; *) return 1;; esac
}

_refuse() {
    {
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🛑 GIT PUSH GUARD — agent-session git $_subcmd REFUSED (dmtools-agents#542)"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        for _v in "$@"; do echo "  ✗ $_v"; done
        echo ""
        echo "Agent sessions never push to the default/protected branch (main/master)."
        echo "Push only to the PR head branch — the ai/<ticket-key> branch or the branch"
        echo "recorded in input/<TICKET>/pr_info.md. Commit, push, and PR publication are"
        echo "performed by the automated post-actions; do not run 'git push' yourself."
        echo "Closing keywords (closes/fixes/resolves #N) belong to the PR body — the"
        echo "squash-merge message owns issue closing, never an agent commit message."
        echo ""
        echo "Escape hatch (human/operator use only): FA_GIT_GUARD_OFF=1"
        echo ""
    } >&2
    exit 2
}

if [ "$_subcmd" = "push" ]; then
    _delete=0; _all=0; _mirror=0
    _remote_seen=0
    _refspecs=()
    _remotes="$("$_real_git" remote 2>/dev/null || true)"
    _i=0
    _rn=${#_rest[@]}
    while [ "$_i" -lt "$_rn" ]; do
        _a="${_rest[$_i]}"
        case "$_a" in
            --mirror) _mirror=1;;
            --all) _all=1;;
            -d|--delete) _delete=1;;
            -o|--push-option|--receive-pack|--exec|--repo) _i=$((_i + 1));;
            -*) ;;  # boolean or joined-value option — no positional meaning
            *)
                # First positional is the remote when it is a configured
                # remote name, a URL, or a path; otherwise a refspec.
                _is_remote=0
                if [ "$_remote_seen" -eq 0 ] && [ ${#_refspecs[@]} -eq 0 ]; then
                    case "$_a" in
                        *://*|*@*|*.git) _is_remote=1;;
                        *)
                            if printf '%s\n' "$_remotes" | grep -qx -- "$_a" 2>/dev/null; then
                                _is_remote=1
                            fi;;
                    esac
                fi
                if [ "$_is_remote" -eq 1 ]; then
                    _remote_seen=1
                else
                    _refspecs+=("$_a")
                fi;;
        esac
        _i=$((_i + 1))
    done

    [ "$_mirror" -eq 1 ] && _refuse "--mirror pushes every ref including protected branches (main/master)"
    [ "$_all" -eq 1 ] && _refuse "--all pushes every local branch including protected branches (main/master)"

    _current_branch="$("$_real_git" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

    if [ ${#_refspecs[@]} -eq 0 ]; then
        # No refspec: push.default sends the CURRENT branch upstream.
        if [ -n "$_current_branch" ] && _is_protected "$_current_branch"; then
            _refuse "push with no refspec would publish the checked-out protected branch \"$_current_branch\""
        fi
    else
        for _spec in "${_refspecs[@]}"; do
            _s="${_spec#+}"
            case "$_s" in
                *:*) _dst="${_s#*:}"; _src="${_s%%:*}";;
                *) _dst="$_s"; _src="$_s";;
            esac
            [ -z "$_dst" ] && _dst="$_src"
            _dst="${_dst#refs/heads/}"
            [ "$_dst" = "HEAD" ] && _dst="$_current_branch"
            # Destinations outside the branch namespace (tags, notes) are not guarded.
            case "$_dst" in refs/*) continue;; esac
            if [ -n "$_dst" ] && _is_protected "$_dst"; then
                if [ "$_delete" -eq 1 ] || [ -z "$_src" ]; then
                    _refuse "push deletes protected branch \"$_dst\" on the remote"
                else
                    _refuse "push targets protected branch \"$_dst\""
                fi
            fi
        done
    fi
    exec "$_real_git" "$@"
fi

# ── commit: closing-keyword guard ───────────────────────────────────────────
if [ "${FA_GIT_GUARD_ALLOW_CLOSING_KEYWORDS:-0}" != "1" ]; then
    _messages=""
    _i=0
    _cn=${#_rest[@]}
    while [ "$_i" -lt "$_cn" ]; do
        _a="${_rest[$_i]}"
        case "$_a" in
            -m|--message)
                if [ $((_i + 1)) -lt "$_cn" ]; then
                    _messages="$_messages
${_rest[$((_i + 1))]}"
                    _i=$((_i + 1))
                fi;;
            -m*)
                _messages="$_messages
${_a#-m}";;
            --message=*)
                _messages="$_messages
${_a#--message=}";;
            -F|--file)
                if [ $((_i + 1)) -lt "$_cn" ]; then
                    _f="${_rest[$((_i + 1))]}"
                    [ -r "$_f" ] && [ "$_f" != "-" ] && _messages="$_messages
$(cat "$_f" 2>/dev/null)"
                    _i=$((_i + 1))
                fi;;
            --file=*)
                _f="${_a#--file=}"
                [ -r "$_f" ] && _messages="$_messages
$(cat "$_f" 2>/dev/null)";;
        esac
        _i=$((_i + 1))
    done
    if [ -n "$_messages" ]; then
        _kw="$(printf '%s\n' "$_messages" | grep -Eio '\b(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+(#[0-9]+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+|https?://[^[:space:]]*/issues/[0-9]+)' 2>/dev/null | head -5 || true)"
        if [ -n "$_kw" ]; then
            _kw_list=()
            while IFS= read -r _k; do _kw_list+=("commit message contains closing keyword \"$_k\""); done <<EOF
$_kw
EOF
            _refuse "${_kw_list[@]}"
        fi
    fi
fi

exec "$_real_git" "$@"
