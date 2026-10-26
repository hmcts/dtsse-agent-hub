#!/usr/bin/env bash
# Stage 1 of an agent-hub virtual agent pod, exec'd by virtual-agent-boot once the workspace is checked out and
# gh is signed in. Signs in to Azure, starts the optional Atlassian sign-in and the workspace's own clone step in
# the background, sets up Claude Code for the model route, reports the web servers listening in the pod, and
# keeps Claude running in tmux session "claude" until SIGTERM. Beside it, it keeps the conversation supervisor
# running, which runs one Claude per HMCTS Assistant conversation in tmux sessions "c-…".
#
# This file is the pod's runtime and ships with the client, so a pod gets it from the package it boots on rather
# than from the repository it clones. Everything that knows how that repository is laid out — which repositories
# it holds, where they go and what to tell a session while they arrive — is behind the one hook this calls,
# .devcontainer/virtual-agent/prepare-workspace.sh.

set -uo pipefail

# virtual-agent-boot exports this; the default is boot's own, so a hand-run of this file in a pod still works.
WS="${VIRTUAL_AGENT_WORKSPACE:-/workspace/cft-workspace}"
STATE="${VIRTUAL_AGENT_STATE:-$(dirname "$WS")/.virtual-agent}"
ROUTE="${AGENT_HUB_MODEL_ROUTE:-own_licence}"
# The agent-hub client every hub call goes through, resolved by agent_hub_client below once node is on PATH.
AH=""
EXIT_FATAL=3
EXIT_NO_CREDENTIAL=4
# Claude's SessionStart hook reads repos-state from here, and the workspace's clone step writes it there.
export VIRTUAL_AGENT_STATE="$STATE"

log() { printf '%s virtual-agent: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# In the background so that SIGTERM is handled while the hub is slow to answer.
status() {
    "$AH" virtual status "$@" &
    wait $! && return 0
    log "could not report status $1"
    return 1
}

stopping=0
cache_pid=""
ports_pid=""
repos_pid=""
atlassian_pid=""
supervisor_pid=""

sleep_interruptibly() {
    sleep "$1" &
    wait $! 2>/dev/null || true
}

bridge_pids() {
    local f pid
    for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/agent-hub/*/bridge.pid; do
        [[ -f "$f" ]] || continue
        pid=$(cat "$f" 2>/dev/null)
        [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && echo "$pid"
    done
}

conversation_sessions() {
    tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^c-'
}

# Each bridge marks its agent offline and uploads the last of the transcript as it stops, which is all
# `agent-hub disable` would add here without opting the session out of auto-enable.
shutdown() {
    stopping=1
    log "SIGTERM: stopping Claude, the conversation supervisor and its sessions, the agent-hub bridges, the workspace's clone step, the Atlassian sign-in, the port watcher and the cache sync"
    tmux kill-session -t claude 2>/dev/null || true
    # The supervisor goes first, so that it starts no session while its sessions are stopped.
    if [[ -n "$supervisor_pid" ]]; then
        kill -TERM -- "-$supervisor_pid" 2>/dev/null || kill -TERM "$supervisor_pid" 2>/dev/null || true
    fi
    conversation_sessions | while read -r name; do tmux kill-session -t "$name" 2>/dev/null; done
    local pids pid waited=0 repos=""
    if [[ -n "$atlassian_pid" ]] && kill -0 "$atlassian_pid" 2>/dev/null; then
        kill -TERM -- "-$atlassian_pid" 2>/dev/null || kill -TERM "$atlassian_pid" 2>/dev/null || true
    fi
    if [[ -n "$repos_pid" ]] && kill -0 "$repos_pid" 2>/dev/null; then
        repos=$repos_pid
        kill -TERM -- "-$repos" 2>/dev/null || kill -TERM "$repos" 2>/dev/null || true
    fi
    pids=$(bridge_pids)
    for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
    while [[ -n "$pids$repos" && "$waited" -lt 50 ]]; do
        pids=$(for pid in $pids; do kill -0 "$pid" 2>/dev/null && echo "$pid"; done)
        [[ -n "$repos" ]] && ! kill -0 -- "-$repos" 2>/dev/null && repos=""
        sleep 0.1
        waited=$((waited + 1))
    done
    [[ -n "$repos" ]] && kill -KILL -- "-$repos" 2>/dev/null
    if [[ -n "$ports_pid" ]] && kill -0 "$ports_pid" 2>/dev/null; then
        kill -TERM "$ports_pid" 2>/dev/null || true
        wait "$ports_pid" 2>/dev/null || true
    fi
    if [[ -n "$cache_pid" ]] && kill -0 "$cache_pid" 2>/dev/null; then
        kill -TERM "$cache_pid" 2>/dev/null || true
        wait "$cache_pid" 2>/dev/null || true
    else
        "$AH" virtual cache-sync --once || true
    fi
    exit 0
}
trap shutdown TERM INT

# The hub has failed the agent (or it cannot work at all): say why and wait to be stopped, rather
# than exit and have the StatefulSet restart into the same failure.
fatal() {
    log "fatal: $1"
    status failed "$1"
    while :; do sleep_interruptibly 3600; done
}

# retry <what> <command…>: until it succeeds, backing off from 30s to 5 minutes; exit 3 is fatal.
retry() {
    local what="$1" delay=30 rc
    shift
    while :; do
        "$@"
        rc=$?
        [[ "$rc" -eq 0 ]] && return 0
        [[ "$rc" -eq "$EXIT_FATAL" ]] && fatal "$what: the hub failed the agent"
        [[ "$stopping" -eq 1 ]] && return 1
        log "$what failed (exit $rc); retrying in ${delay}s"
        sleep_interruptibly "$delay"
        delay=$((delay * 2 > 300 ? 300 : delay * 2))
    done
}

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
# shellcheck disable=SC1091
[[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
set -u

# The same precedence virtual-agent-boot uses: a workspace shim first, so a checkout can pin an older client
# than the pod's image carries, but only when it runs — a shim that needs an install nothing has done would
# otherwise take every hub call with it, and the pod would report nothing while a working client sat on PATH.
agent_hub_client() {
    local shim="$WS/scripts/agent-hub"
    if [[ -x "$shim" ]] && "$shim" help >/dev/null 2>&1; then
        printf '%s\n' "$shim"
        return 0
    fi
    command -v agent-hub
}
AH=$(agent_hub_client) || AH=""

command -v node >/dev/null || fatal "node is not on PATH"
command -v tmux >/dev/null || fatal "tmux is not installed in the image"
command -v npm >/dev/null || fatal "npm is not on PATH, so hai cannot be installed"
# Reported through the hub as every other fatal is, which needs a client to report it with: with none, fatal
# can only log the reason and wait to be stopped. Unreachable for a pod booted by virtual-agent-boot, which
# ships this file and the client together.
[[ -n "$AH" ]] || fatal "no agent-hub client: neither $WS/scripts/agent-hub nor an agent-hub on PATH"

# The image carries hai, and this install is still what keeps a pod current: it is not redundant,
# so do not remove it. hai updates itself when it runs, which is what makes an image floor good
# enough for a laptop — but a pod sets HAI_NO_UPDATE=1 (from the hub's pod template, and exported
# with the route below), precisely so that the main session and every conversation session do not
# race an `npm install -g` into the one nvm prefix between them. With that self-update off, the
# image's layer is a build-cache hit frozen at whatever `@latest` resolved on the build that last
# ran it, and nothing else would ever move a pod off it. So boot installs on every boot, not only
# when hai is missing: boot chooses the version and the pod is pinned to it for its lifetime
# instead of shifting under a running agent mid-work.
# The hmcts-lib feed allows anonymous reads, so no credential is involved, and the registry is set
# for the @hmcts-cft scope alone because a bare --registry would send every other package there.
# Same command as the client's own install and the devcontainer image's use for the client.
HAI_REGISTRY="--@hmcts-cft:registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/"

# Sourcing nvm.sh above is what makes hai resolve, not anything here: it prepends
# $NVM_DIR/versions/node/<version>/bin to PATH, and that is both where the image installs hai and
# where this install writes it, so every session started below — the main one and each
# conversation session the supervisor starts — inherits a PATH that finds it. The $prefix/bin
# export is a fallback for an npm whose global prefix is not on PATH already, which no pod on a
# current image has; it stays for a pod whose image predates hai, where this install is the only
# thing that provides one at all.
#
# What happens when the install does not work turns on whether a hai resolves at all afterwards,
# and on how many attempts have been spent.
#   - It failed, one resolves, and the attempts are spent. Boot names npm's reason and the version
#     it is keeping, puts that version in the running detail so the owner's page carries it too,
#     and starts Claude on it. The pod then runs that hai for its whole lifetime: HAI_NO_UPDATE=1
#     stops it updating itself, and the global prefix is in the container filesystem rather than
#     the volume, so nothing else moves it either.
#   - It failed, one resolves, and there are attempts left. retry() goes round, with the rest of
#     boot's dependencies. Both extremes here are wrong, so it is bounded rather than either:
#     retrying for ever holds every pod that boots during a long Azure Artifacts outage at
#     provisioning with a working hai sitting on PATH, while falling through on the first failure
#     pins a pod to the image's floor over a one-second DNS flake or a single 503 — and a floor old
#     enough to lack something this file depends on gives the worst outcome of the three, a hai
#     that misbehaves while the hub says `running`, where retrying would have had a working one
#     thirty seconds later. HAI_INSTALL_TRIES attempts at retry()'s 30s then 60s spends about 90
#     seconds of provisioning before accepting the floor.
#   - It failed and nothing resolves. An image from before hai was baked in, with a feed that is
#     down, so there is nothing to fall back to and the bound does not apply: retry() keeps going,
#     backing off from 30 seconds to 5 minutes, because an Artifacts blip should delay such a pod
#     rather than end it, and the owner has nothing to act on while it may yet fix itself.
#   - npm reported success and nothing resolves. Reachable only on such an image, and a genuine
#     dead end, so it is reported and stops: retrying would only produce the same success. npm
#     missing from the image is checked above for the same reason.
HAI_INSTALL_TRIES=3
hai_tries=0
# Empty unless boot fell back; repos_detail appends it to the running detail.
hai_note=""
install_hai() {
    local out rc=0 prefix version reason
    hai_tries=$((hai_tries + 1))
    # --ignore-scripts: nothing in this install needs a lifecycle script, and a pod runs it unattended on
    # every boot. @hmcts-cft/hai-cli declares none and has no dependencies to declare any.
    out=$(npm install -g --ignore-scripts --no-fund --no-audit --fetch-timeout=60000 --fetch-retries=2 \
        "$HAI_REGISTRY" @hmcts-cft/hai-cli@latest 2>&1) || rc=$?
    if ! command -v hai >/dev/null; then
        prefix=$(npm prefix -g 2>/dev/null)
        if [[ -n "$prefix" && -x "$prefix/bin/hai" ]]; then
            PATH="$prefix/bin:$PATH"
            export PATH
        fi
    fi
    version=$(npm ls -g --depth=0 @hmcts-cft/hai-cli 2>/dev/null | grep -o 'hai-cli@[^ ]*' | head -1)
    if [[ "$rc" -ne 0 ]]; then
        # npm says several lines and this is one, so the reason travels flattened and clipped.
        reason="${out//[$'\n\t']/ }"
        if command -v hai >/dev/null && [[ "$hai_tries" -ge "$HAI_INSTALL_TRIES" ]]; then
            hai_note="running the image's ${version:-hai}, as the feed install failed"
            log "hai: installing from the hmcts-lib feed failed $hai_tries times, so this pod" \
                "keeps the image's ${version:-hai} for its whole lifetime: ${reason:0:200}"
            return 0
        fi
        log "hai: installing from the hmcts-lib feed failed: ${reason:0:200}"
        return 1
    fi
    command -v hai >/dev/null ||
        fatal "installing hai reported success but no hai binary could be found"
    log "hai: installed ${version:-@hmcts-cft/hai-cli} from the hmcts-lib feed"
}
# install_hai normalises every transient failure to 1, so retry() never reads one as the hub
# having failed the agent (its exit 3).
retry "the hai install" install_hai

cd "$WS" || fatal "cannot cd to $WS"
mkdir -p "$STATE"

retry "azure sign-in" "$AH" virtual azure-login

"$AH" virtual cache-sync &
cache_pid=$!

"$AH" virtual watch-ports &
ports_pid=$!

ATLASSIAN_TRIES=3

# Jira and Confluence through twg are optional, so the sign-in never holds up Claude and a failure
# only leaves twg signed out. A device code is relayed to the owner at most once a boot: exit 4
# means they did not complete it. Other failures are retried a few times.
atlassian_login() {
    local try rc delay=60
    for ((try = 1; try <= ATLASSIAN_TRIES; try++)); do
        "$AH" virtual atlassian-login
        rc=$?
        [[ "$rc" -eq 0 ]] && return 0
        if [[ "$rc" -eq "$EXIT_NO_CREDENTIAL" ]]; then
            log "atlassian: not signed in; Jira and Confluence stay unconfigured until the next boot"
            return 0
        fi
        [[ "$try" -lt "$ATLASSIAN_TRIES" ]] || break
        log "atlassian sign-in failed (exit $rc); retrying in ${delay}s"
        sleep "$delay"
        delay=$((delay * 2))
    done
    log "atlassian sign-in failed $ATLASSIAN_TRIES times; Jira and Confluence stay unconfigured until the next boot"
}

# Monitor mode gives the sign-in its own process group, so SIGTERM stops twg with it.
start_atlassian() {
    if ! command -v twg >/dev/null; then
        log "atlassian: twg is not installed; Jira and Confluence stay unconfigured"
        return 0
    fi
    set -m
    atlassian_login &
    atlassian_pid=$!
    set +m
}

# Succeeds once, when the background sign-in has just finished.
poll_atlassian() {
    [[ -n "$atlassian_pid" ]] || return 1
    kill -0 "$atlassian_pid" 2>/dev/null && return 1
    wait "$atlassian_pid" 2>/dev/null
    atlassian_pid=""
    return 0
}

start_atlassian

REPOS_STATE="$STATE/repos-state"
REPOS_LOG="$STATE/repos.log"
REPOS_RC="$STATE/repos.rc"
# The clone step the workspace declares. It knows which repositories the workspace holds, where they go and
# what to tell a session while they are still arriving, so it owns the note= line of repos-state; only state=,
# done= and total= are read back here. A workspace that declares none simply has no clone step.
PREPARE="$WS/.devcontainer/virtual-agent/prepare-workspace.sh"
REPORT_EVERY=15
# 1 once the clone step running is the hook rather than the fallback below.
repos_hook=0
repos_kind=""
repos_state=""
repos_done=0
repos_total=0
reported=""
reported_at=0

# Runs the clone step in the background at low priority behind Claude, with its own process group so that
# SIGTERM stops it and the git clones under it, and its exit status in repos.rc once it is over.
start_in_background() {
    rm -f "$REPOS_RC"
    : >"$REPOS_LOG"
    set -m
    (
        nice -n 10 "$@" </dev/null >>"$REPOS_LOG" 2>&1
        echo $? >"$REPOS_RC.tmp" && mv "$REPOS_RC.tmp" "$REPOS_RC"
    ) &
    repos_pid=$!
    set +m
}

# The clone step's progress as it was last written. note= is deliberately not read: it is for the client's
# SessionStart hook, which reads the file itself.
read_repos_state() {
    local line
    [[ -f "$REPOS_STATE" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        case "$line" in
            state=*) repos_state="${line#state=}" ;;
            done=*) repos_done="${line#done=}" ;;
            total=*) repos_total="${line#total=}" ;;
        esac
    done <"$REPOS_STATE"
    # Which of the two the step is doing is only ever said in state=, and repos_detail needs it after the
    # state has moved on to failed.
    case "$repos_state" in cloning | syncing) repos_kind="$repos_state" ;; esac
    [[ "$repos_done" =~ ^[0-9]+$ ]] || repos_done=0
    [[ "$repos_total" =~ ^[0-9]+$ ]] || repos_total=0
}

# Writes the clone step's state as this file knows it. Never a note= line: the sentence a session is given
# belongs to whatever did the cloning, and the client has a generic one of its own for a state that carries
# none, which is better than a stale sentence from a step that is no longer running.
write_repos_state() {
    printf 'state=%s\ndone=%s\ntotal=%s\nupdated=%s\n' "$repos_state" "$repos_done" "$repos_total" \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$REPOS_STATE.tmp" && mv "$REPOS_STATE.tmp" "$REPOS_STATE"
}

# What the clone step is doing, as a verb for a sentence about it: "arrive" until it has said which of the two
# it is, because only state= ever says so.
repos_verb() {
    case "$repos_kind" in
        cloning) printf 'clone' ;;
        syncing) printf 'sync' ;;
        *) printf 'arrive' ;;
    esac
}

# --- The fallback, which goes once every checkout carries prepare-workspace.sh. ---
# A checkout from before the workspace declared the step: the two scripts boot has always run, the same log,
# and the counts taken from that log rather than from a state file, so a session still gets the client's
# generic sentence about the repositories rather than nothing at all. The apps/, libs/ and platops/ wording is
# the workspace's and arrives with the hook.
fallback_count() {
    read -r repos_done repos_total < <(awk '
        /^(Cloning into|Syncing) [0-9]+ / { total = $(/^Syncing/ ? 2 : 3) }
        /^(OK|ERR|SKIP|MISS) / || / skip \(/ { done++ }
        END { print done + 0, total + 0 }' "$REPOS_LOG" 2>/dev/null)
}

fallback_start() {
    local cmd
    if [[ -f "$STATE/bootstrapped" ]]; then
        repos_kind=syncing
        cmd=("$WS/scripts/sync" -j16)
    else
        repos_kind=cloning
        cmd=("$WS/scripts/bootstrap" --no-ssh-check --filter=blob:none -j16)
    fi
    repos_state=$repos_kind
    start_in_background "${cmd[@]}"
    write_repos_state
    log "$repos_kind the workspace repos in the background; log in $REPOS_LOG"
}

fallback_finished() {
    fallback_count
    if [[ "$1" == 0 ]]; then
        repos_state="done"
        [[ "$repos_kind" == cloning ]] && date -u +%Y-%m-%dT%H:%M:%SZ >"$STATE/bootstrapped"
        log "the workspace repos are ready"
    else
        repos_state=failed
        log "the background $(repos_verb) reported failures; see $REPOS_LOG (the next boot runs it again)"
    fi
    write_repos_state
}
# --- End of the fallback. ---

# Claude starts while the repositories arrive, so the clone step runs behind it.
start_repos() {
    if [[ -x "$PREPARE" ]]; then
        repos_hook=1
        # The state dir is on the volume, so the file still holds the last boot's result until the step writes
        # its own. Left there, a step that dies before its first write would be read as that boot's success,
        # and until then this boot's progress would be whatever that one ended on.
        rm -f "$REPOS_STATE"
        start_in_background "$PREPARE"
        log "running the workspace's clone step ($PREPARE) in the background; log in $REPOS_LOG"
    elif [[ -x "$WS/scripts/bootstrap" ]]; then
        fallback_start
    else
        log "the workspace declares no clone step ($PREPARE); nothing is cloned or synced"
    fi
}

repos_progress() {
    if [[ "$repos_hook" -eq 1 ]]; then
        read_repos_state
    else
        fallback_count
        write_repos_state
    fi
}

# How the clone step ended, given its exit status.
repos_finished() {
    if [[ "$repos_hook" -eq 0 ]]; then
        fallback_finished "$1"
        return 0
    fi
    read_repos_state
    case "$repos_state" in
        done) log "the workspace repositories are ready" ;;
        failed) log "the workspace's clone step reported failures; see $REPOS_LOG (the next boot runs it again)" ;;
        # The step is what says how it ended, so one that stops without saying — killed for memory, or dead on
        # an error it does not handle — is taken as failed, and that is written rather than only reported: the
        # client's SessionStart hook reads the file, so a state left at cloning tells every session for the
        # rest of the pod's life that the repositories are still on their way and that nothing should fetch
        # them. The step's note= goes with it, as write_repos_state writes none: a sentence about a clone that
        # is no longer running is worse than the generic one the client uses without one.
        *)
            repos_state=failed
            log "the workspace's clone step exited (status $1) without finishing $REPOS_STATE; taking it as failed"
            write_repos_state
            ;;
    esac
}

poll_repos() {
    [[ -n "$repos_pid" ]] || return 0
    if [[ ! -f "$REPOS_RC" ]] && kill -0 "$repos_pid" 2>/dev/null; then
        repos_progress
        return 0
    fi
    wait "$repos_pid" 2>/dev/null
    repos_pid=""
    repos_finished "$(cat "$REPOS_RC" 2>/dev/null)"
}

repos_detail() {
    case "$repos_state" in
        cloning | syncing)
            printf 'Claude is ready; %s repositories' "$repos_state"
            [[ "$repos_total" -gt 0 ]] && printf ' (%s/%s)' "$repos_done" "$repos_total"
            ;;
        done) printf 'Claude is ready; repositories ready' ;;
        failed) printf 'Claude is ready; some repositories failed to %s (see %s)' "$(repos_verb)" "$REPOS_LOG" ;;
        *) printf 'Claude is ready' ;;
    esac
    # A stale hai is otherwise only in the boot log, which the owner does not see. It rides along
    # on every detail rather than being reported on its own: report_running compares the whole
    # string against the last one sent, so a second phase line would be dropped as a duplicate as
    # soon as the repos stopped moving.
    if [[ -n "$hai_note" ]]; then
        printf '; %s' "$hai_note"
    fi
}

# report_running [now]: phase running with the repos' progress, at most every REPORT_EVERY
# seconds while they are still arriving, unless "now".
report_running() {
    local detail at
    detail=$(repos_detail)
    at=$(date +%s)
    if [[ "${1:-}" != now ]]; then
        [[ "$detail" == "$reported" ]] && return 0
        [[ "$repos_state" == cloning || "$repos_state" == syncing ]] &&
            [[ $((at - reported_at)) -lt "$REPORT_EVERY" ]] && return 0
    fi
    status running "$detail" && reported=$detail && reported_at=$at
}

start_repos

seed_claude_config() {
    local version tmp
    version=$(claude --version 2>/dev/null | awk '{print $1}')
    tmp=$(mktemp)
    [[ -s "$HOME/.claude.json" ]] || echo '{}' >"$HOME/.claude.json"
    jq --arg cwd "$WS" --arg version "${version:-0}" '
        . * {
          hasCompletedOnboarding: true,
          projects: {($cwd): {
            hasTrustDialogAccepted: true,
            hasClaudeMdExternalIncludesApproved: true,
            hasClaudeMdExternalIncludesWarningShown: true
          }}
        }
        | .lastOnboardingVersion //= $version
    ' "$HOME/.claude.json" >"$tmp" && mv "$tmp" "$HOME/.claude.json"
    mkdir -p "$HOME/.claude"
    [[ -s "$HOME/.claude/settings.json" ]] || echo '{}' >"$HOME/.claude/settings.json"
    tmp=$(mktemp)
    jq '. * {skipDangerousModePermissionPrompt: true}' "$HOME/.claude/settings.json" >"$tmp" &&
        mv "$tmp" "$HOME/.claude/settings.json"
}
seed_claude_config || fatal "could not seed ~/.claude.json"

# Another of the workspace's own, and optional for the same reason the clone step is.
[[ -f "$WS/.devcontainer/install-twg-skills.sh" ]] && bash "$WS/.devcontainer/install-twg-skills.sh" >&2

claude_token() {
    local token rc
    token=$("$AH" virtual credential get claude)
    rc=$?
    [[ "$rc" -eq 0 ]] || return "$rc"
    CLAUDE_CODE_OAUTH_TOKEN="$token"
    export CLAUDE_CODE_OAUTH_TOKEN
}

# Waits until the owner has stored the agent's Bedrock key, then exports it for hai. It runs
# again before every restart, so a key replaced on the hub is picked up by the next session.
bedrock_key() {
    local key rc waiting=0
    bedrock_waited=0
    while [[ "$stopping" -eq 0 ]]; do
        key=$("$AH" credentials get bedrock)
        rc=$?
        if [[ "$rc" -eq 0 && -n "$key" ]]; then
            AWS_BEARER_TOKEN_BEDROCK="$key"
            export AWS_BEARER_TOKEN_BEDROCK
            [[ "$waiting" -eq 1 ]] && log "bedrock: the API key is stored"
            bedrock_waited=$waiting
            return 0
        fi
        if [[ "$rc" -eq 0 || "$rc" -eq "$EXIT_NO_CREDENTIAL" ]]; then
            if [[ "$waiting" -eq 0 ]]; then
                log "bedrock: no API key stored; waiting for the owner"
                status awaiting_credentials "bedrock: paste your Amazon Bedrock API key on this agent's page"
                waiting=1
            fi
        else
            log "could not read the bedrock credential (exit $rc); retrying in 15s"
        fi
        sleep_interruptibly 15
    done
    return 1
}

JENKINS_ENV="$WS/.claude/.jenkins.env"
jenkins_oid=""
jenkins_state=""

# Writes .claude/.jenkins.env for the workspace's Jenkins MCP server from the owner's Jenkins API token, when
# they have stored one. Jenkins keys users on their Entra object id, and az is signed in as the owner.
# Without a token Jenkins stays unconfigured; that never holds up boot.
jenkins_env() {
    local token rc tmp
    token=$("$AH" credentials get jenkins)
    rc=$?
    if [[ "$rc" -eq "$EXIT_NO_CREDENTIAL" || ("$rc" -eq 0 && -z "$token") ]]; then
        rm -f "$JENKINS_ENV"
        [[ "$jenkins_state" == absent ]] || log "jenkins: no API token stored; the Jenkins MCP server stays unconfigured"
        jenkins_state=absent
        return 0
    fi
    if [[ "$rc" -ne 0 ]]; then
        log "could not read the jenkins credential (exit $rc); keeping the current Jenkins configuration"
        return 0
    fi
    if [[ "$token" == *[[:space:]]* ]]; then
        log "jenkins: the stored API token contains whitespace; ignoring it"
        return 0
    fi
    [[ -n "$jenkins_oid" ]] || jenkins_oid=$(az ad signed-in-user show --query id -o tsv 2>/dev/null)
    if [[ ! "$jenkins_oid" =~ ^[0-9a-fA-F-]{36}$ ]]; then
        jenkins_oid=""
        log "jenkins: could not read the owner's Entra object id from az; leaving Jenkins unconfigured"
        return 0
    fi
    tmp=$(umask 077 && mktemp "$JENKINS_ENV.XXXXXX") || return 0
    if ! printf 'JENKINS_URL=https://build.hmcts.net/\nJENKINS_USERNAME=%s\nJENKINS_PASSWORD=%s\nJENKINS_TIMEOUT=30\nJENKINS_VERIFY_SSL=true\n' \
        "$jenkins_oid" "$token" >"$tmp" || ! mv -f "$tmp" "$JENKINS_ENV"; then
        rm -f "$tmp"
        log "jenkins: could not write $JENKINS_ENV"
        return 0
    fi
    [[ "$jenkins_state" == present ]] || log "jenkins: API token stored; the Jenkins MCP server is configured"
    jenkins_state=present
}

CLAUDE_MD="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md"
# The same text agent-hub gives a pod whose owner has stored none, for a hub without the kind.
DEFAULT_CLAUDE_MD="You are running in a pod in Preview and connected via the agent hub."
claude_md_state=""

# Writes the owner's CLAUDE.md, as agent-hub keeps it, to Claude's user memory file. The text goes
# straight to a file rather than through $(…), which would drop its trailing newlines. A hub that
# cannot be read leaves an existing file as it is, so Claude starts with the last one; that never
# holds up boot.
claude_md() {
    local tmp rc state
    mkdir -p "$(dirname "$CLAUDE_MD")" 2>/dev/null
    tmp=$(umask 077 && mktemp "$CLAUDE_MD.XXXXXX") || return 0
    "$AH" credentials get claude_md >"$tmp"
    rc=$?
    if [[ "$rc" -eq "$EXIT_NO_CREDENTIAL" || ("$rc" -eq 0 && ! -s "$tmp") ]]; then
        printf '%s' "$DEFAULT_CLAUDE_MD" >"$tmp"
        state=default
    elif [[ "$rc" -eq 0 ]]; then
        state=stored
    elif [[ -f "$CLAUDE_MD" ]]; then
        rm -f "$tmp"
        log "could not read the claude_md credential (exit $rc); keeping the current $CLAUDE_MD"
        return 0
    else
        printf '%s' "$DEFAULT_CLAUDE_MD" >"$tmp"
        state=default
        log "could not read the claude_md credential (exit $rc); writing the default"
    fi
    if ! mv -f "$tmp" "$CLAUDE_MD"; then
        rm -f "$tmp"
        log "claude_md: could not write $CLAUDE_MD"
        return 0
    fi
    [[ "$claude_md_state" == "$state" ]] || log "claude_md: wrote the $state CLAUDE.md to $CLAUDE_MD"
    claude_md_state=$state
}

# ~/.gitconfig is not on the persistent volume, so the identity is set again before every start.
# It never holds up boot: a commit without one fails later with git's own message.
git_identity() {
    "$AH" virtual git-identity || log "git: could not set the git identity; keeping the current one"
}

case "$ROUTE" in
    own_licence)
        while :; do
            claude_token
            rc=$?
            [[ "$rc" -eq 0 ]] && break
            if [[ "$rc" -eq "$EXIT_NO_CREDENTIAL" ]]; then
                retry "claude sign-in" "$AH" virtual claude-login
            else
                log "could not read the claude credential (exit $rc); retrying in 30s"
                sleep_interruptibly 30
            fi
        done
        unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK
        ;;
    bedrock | gateway)
        ROUTE=bedrock
        bedrock_key
        unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
        ;;
    *)
        fatal "unknown AGENT_HUB_MODEL_ROUTE: $ROUTE"
        ;;
esac
# The settings every session in this pod starts with, passed inline rather than as a file:
# `claude --settings` keeps only the last one it is given, so this has to be a single object, and
# both readers (hai, and the client's summariser through AGENT_HUB_CLAUDE_SETTINGS) take JSON as
# readily as a path. crossSessionInbound has to come in this way because Claude Code ignores it in
# a project's .claude/settings.json, and it is what lets the owner's direct messages arrive as
# turns instead of being held. AGENT_HUB_AUTO_ENABLE puts comms on without anyone to run
# /enable-comms, and KNOWLEDGE_SWEEP_CHILD keeps the knowledge sweep out of a pod — it is read
# before the workspace's knowledge sweep reaches anything else, so no session in a pod ever sweeps.
CLAUDE_SETTINGS='{"crossSessionInbound":"accept","env":{"AGENT_HUB_AUTO_ENABLE":"true","KNOWLEDGE_SWEEP_CHILD":"1"}}'

# AGENT_HUB_MODEL_ROUTE is the hub's contract and says who pays for the agent; HAI_ROUTE says
# which credential hai uses, and the route branch above has already exported that credential.
# An explicit HAI_ROUTE means "use the credential you were handed", so byol spends the hub's
# Claude token whatever Entra groups the owner happens to be in.
case "$ROUTE" in
    own_licence) HAI_ROUTE=byol ;;
    *) HAI_ROUTE=bedrock ;;
esac

# HAI_IN_CONTAINER=1 is not inferable: hai runs the session in a container of its own unless it can
# tell it is already in one, and none of the signals it looks for is true in a pod. AKS runs
# containerd, which creates no /.dockerenv, and this is neither a devcontainer nor a Docker
# sandbox. Without this, hai takes container mode and dies pulling an image, because a pod has
# no Docker socket, no privilege escalation and no root. HAI_ENV_READY would also stop that, but
# it short-circuits route resolution with it, and the bedrock route needs the environment that
# resolution builds. HAI_NO_UPDATE=1 is the other half of the hai install above.
#
# The hub's pod template sets both of these as well, and setting them here too is deliberate rather
# than defensive: a running agent picks up a new runtime with its next client upgrade, but it does
# not get a new pod template until its pod_generation moves, so for a pod still on an older
# template these exports are the only ones there are. That matters most for HAI_NO_UPDATE, because
# such a pod runs this file's per-boot hai install and then starts a session per conversation beside
# the main one, each of which would otherwise be free to self-update into the same nvm prefix at the
# same time. Once every pod has cycled onto a current template the two sets are belt and braces.
export AGENT_HUB_MODEL_ROUTE="$ROUTE" HAI_ROUTE HAI_IN_CONTAINER=1 HAI_NO_UPDATE=1 \
    AGENT_HUB_CLAUDE_SETTINGS="$CLAUDE_SETTINGS"

# `claude --continue` exits at once when the project has no conversation yet.
has_conversation() {
    local dir
    dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf '%s' "$WS" | tr -c 'A-Za-z0-9' '-')"
    compgen -G "$dir/*.jsonl" >/dev/null
}

# The settings are single-quoted for the shell tmux runs the command line in; the JSON above
# holds no single quote of its own.
start_claude() {
    local launch="hai --settings '$CLAUDE_SETTINGS' --dangerously-skip-permissions"
    has_conversation && launch="$launch --continue"
    tmux new-session -d -s claude -x 220 -y 50 -c "$WS" "$launch"
}

# The conversation supervisor starts one Claude per HMCTS Assistant conversation that the hub wakes,
# beside the main session, and is restarted with the same backoff as Claude. A Bedrock key replaced
# on the hub is picked up by its next start. Monitor mode gives it its own process group, so SIGTERM
# stops the restart loop with it.
supervise() {
    local rc started key delay=5
    while :; do
        started=$(date +%s)
        "$AH" virtual assistant-supervisor
        rc=$?
        if [[ "$rc" -eq "$EXIT_FATAL" ]]; then
            log "the conversation supervisor: the hub failed the agent; not restarting it"
            return
        fi
        [[ $(($(date +%s) - started)) -gt 600 ]] && delay=5
        log "the conversation supervisor exited (exit $rc); restarting in ${delay}s"
        sleep "$delay"
        delay=$((delay * 2 > 300 ? 300 : delay * 2))
        if [[ "$ROUTE" == bedrock ]] && key=$("$AH" credentials get bedrock) && [[ -n "$key" ]]; then
            AWS_BEARER_TOKEN_BEDROCK="$key"
            export AWS_BEARER_TOKEN_BEDROCK
        fi
    done
}

start_supervisor() {
    set -m
    supervise &
    supervisor_pid=$!
    set +m
    log "the conversation supervisor started"
}

poll_repos
report_running now
delay=5
while [[ "$stopping" -eq 0 ]]; do
    git_identity
    jenkins_env
    claude_md
    # Once, after the owner's git identity, Jenkins token and CLAUDE.md are first applied.
    [[ -n "$supervisor_pid" ]] || start_supervisor
    started=$(date +%s)
    if start_claude; then
        log "Claude started in tmux session claude"
        while [[ "$stopping" -eq 0 ]] && tmux has-session -t claude 2>/dev/null; do
            sleep_interruptibly 5
            poll_repos
            # A relayed Atlassian sign-in reported awaiting_login over running.
            if poll_atlassian; then report_running now; else report_running; fi
        done
    else
        log "tmux could not start the session"
    fi
    [[ "$stopping" -eq 1 ]] && break
    [[ $(($(date +%s) - started)) -gt 600 ]] && delay=5
    log "the Claude session ended; restarting in ${delay}s"
    sleep_interruptibly "$delay"
    delay=$((delay * 2 > 300 ? 300 : delay * 2))
    bedrock_waited=0
    if [[ "$ROUTE" == bedrock ]]; then
        bedrock_key || break
    fi
    poll_repos
    if [[ "$bedrock_waited" -eq 1 ]]; then report_running now; else report_running; fi
done
