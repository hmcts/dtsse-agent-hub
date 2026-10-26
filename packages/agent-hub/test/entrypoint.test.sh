#!/usr/bin/env bash
# virtual-agent/entrypoint.sh — stage 1 of a virtual agent's pod — against fake tmux, hai, claude, jq, node,
# npm, an agent-hub client and a workspace, in a throwaway copy of that workspace. One case per run.
#
# src/virtual-agent-entrypoint.test.ts drives it, and reads its `ok <name>` / `FAIL <name>: …` lines:
#
#   bash test/entrypoint.test.sh first-boot
#   bash test/entrypoint.test.sh --list          # the case names, which is what the wrapper iterates
#
# It must also run under bash 3.2, which is the version macOS ships, and in that image it has to run detached
# or its output is lost:
#
#   docker run -d --name entrypoint-test -v "$PWD:/w:ro" -w /w bash:3.2 bash test/entrypoint.test.sh first-boot
#   docker logs -f entrypoint-test
#
# ENTRYPOINT is the script under test, so it can be pointed elsewhere.

# ok and no always succeed, so `test && ok || no` never runs both; the fakes expand $FAKE_DIR when they run.
# shellcheck disable=SC2015,SC2016
set -u

CASES=(first-boot bedrock-route legacy-gateway-route unknown-route hai-install-blip-recovers hai-install-falls-back
    hai-installed-off-path hai-install-retries hai-install-keeps-failing hai-install-leaves-no-binary
    continues-a-conversation git-identity-fails later-boot-fails sigterm-mid-clone claude-md-stored
    claude-md-missing claude-md-error claude-md-restart atlassian-fails atlassian-not-signed-in atlassian-sigterm
    atlassian-no-twg conversations prepare-workspace prepare-workspace-fails prepare-workspace-dies
    prepare-workspace-dies-silently prepare-workspace-sigterm
    no-clone-step client-on-path broken-workspace-shim)

if [ "${1:-}" = "--list" ]; then
    printf '%s\n' "${CASES[@]}"
    exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENTRYPOINT="${ENTRYPOINT:-$ROOT/virtual-agent/entrypoint.sh}"
# Captured before any fake shadows it: this script's own waits and its watchdog must still take real time, and
# so must the fakes whose sleeps are a process lifetime or the pace of a clone rather than a backoff.
REAL_SLEEP="$(command -v sleep)"
T="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
no() {
    fail=$((fail + 1))
    printf 'FAIL %s: %s\n' "$CASE" "$1"
    for f in "$T/out" "$F/hub.log" "$F/claude.log" "$STATE/repos-state"; do
        [ -f "$f" ] && sed "s#^#     $(basename "$f") | #" "$f"
    done
}
# A case the host cannot run. The wrapper allows a run that asserts nothing only when one of these is printed.
skip() { printf 'skip %s: %s\n' "$CASE" "$1"; }

# wait_for <seconds> <command…>
wait_for() {
    local n=$(($1 * 10))
    shift
    while [ "$n" -gt 0 ]; do
        "$@" && return 0
        sleep 0.1
        n=$((n - 1))
    done
    return 1
}

setup() {
    CASE="$1"
    W="$T/$1/cft-workspace"
    F="$T/$1/fake"
    STATE="$T/$1/.virtual-agent"
    # A case that replaced the PATH the fakes are on must not leave the next one pointing at its directories.
    START_PATH=""
    mkdir -p "$W/.devcontainer/virtual-agent" "$W/scripts" "$W/.claude" "$F/bin" "$T/$1/home"

    # One process per named session, its pid in tmux.<name>.pid.
    cat >"$F/bin/tmux" <<'EOF'
#!/usr/bin/env bash
cmd=$1
shift
name=""
while [ $# -gt 1 ]; do
    case "$1" in -c) cd "$2" || exit 1; shift 2 ;; -s | -t) name=$2; shift 2 ;; -x | -y | -e | -F) shift 2 ;; *) shift ;; esac
done
pid=$(cat "$FAKE_DIR/tmux.$name.pid" 2>/dev/null)
case "$cmd" in
    new-session)
        sh -c "$1" </dev/null >/dev/null 2>&1 &
        echo $! >"$FAKE_DIR/tmux.$name.pid" ;;
    has-session) kill -0 "$pid" 2>/dev/null ;;
    kill-session) kill "$pid" 2>/dev/null ;;
    list-sessions)
        for f in "$FAKE_DIR"/tmux.*.pid; do
            [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null || continue
            f=${f##*/tmux.}
            echo "${f%.pid}"
        done ;;
esac
EOF
    # The pause is what makes the clone step's first write land before the entrypoint's first report: seeding
    # Claude's config runs this between the two, and in a pod the step has minutes of clone to spare where this
    # suite has milliseconds. Real, so faking the backoffs below does not take it away.
    printf '#!/bin/sh\n"%s" 0.3\necho "2.1.0 (Claude Code)"\n' "$REAL_SLEEP" >"$F/bin/claude"
    cat >"$F/bin/jq" <<'EOF'
#!/bin/sh
for a; do f=$a; done
cat "$f"
EOF
    printf '#!/bin/sh\nexit 0\n' >"$F/bin/node"

    # Every backoff the entrypoint waits out is a `sleep` on this PATH — retry()'s 30s and 60s, the restart
    # delay, fatal()'s hour — and waiting them out is what made this suite take minutes. The schedule is
    # asserted on the interval each one logs instead, so the wait itself buys nothing. The fakes below keep
    # $REAL_SLEEP: their sleeps are process lifetimes and the pace of a clone, and shortening those would
    # leave a case asserting on a session or a clone that had already ended.
    printf '#!/bin/sh\nexec "%s" 0.05\n' "$REAL_SLEEP" >"$F/bin/sleep"

    # Records the argv, the launch environment and the working directory of every start, so what the entrypoint
    # hands hai — the route, the inline settings, the credential and the workspace it took from the environment
    # — is asserted on, not just that something started. Written as the template the fake npm "installs", and
    # put on PATH as well, so that a case which removes it from PATH is left with only the installed copy.
    cat >"$F/hai-template" <<EOF
#!/bin/sh
REAL_SLEEP="$REAL_SLEEP"
EOF
    cat >>"$F/hai-template" <<'EOF'
n=$(($(cat "$FAKE_DIR/claude.count" 2>/dev/null || echo 0) + 1))
echo "$n" >"$FAKE_DIR/claude.count"
echo "start $n $(grep '^state=' "$VIRTUAL_AGENT_STATE/repos-state" 2>/dev/null)" >>"$FAKE_DIR/claude.log"
echo "claude $n" >>"$FAKE_DIR/order.log"
printf '%s\n' "$@" >"$FAKE_DIR/hai.argv.$n"
pwd >"$FAKE_DIR/hai.pwd.$n"
env | grep -E '^(HAI_ROUTE|HAI_IN_CONTAINER|HAI_NO_UPDATE|AGENT_HUB_MODEL_ROUTE|AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CODE_OAUTH_TOKEN|AGENT_HUB_CLAUDE_SETTINGS)=' | sort >"$FAKE_DIR/hai.env.$n"
cp "$HOME/.claude/CLAUDE.md" "$FAKE_DIR/claude_md.seen.$n" 2>/dev/null
if [ "$n" -eq 1 ] && [ -n "${FAKE_CLAUDE_EXIT_FIRST:-}" ]; then "$REAL_SLEEP" 2; exit 0; fi
exec "$REAL_SLEEP" 1000
EOF
    chmod +x "$F/hai-template"
    cp "$F/hai-template" "$F/bin/hai"

    # Installs the hai template into its own global prefix, which is deliberately not on PATH:
    # the entrypoint has to add it. FAKE_NPM_FAIL makes every install fail the way a feed that is
    # not answering does, FAKE_NPM_FAIL_FIRST only the first, and FAKE_NPM_EMPTY makes npm report
    # success while installing nothing.
    cat >"$F/bin/npm" <<'EOF'
#!/bin/sh
echo "$*" >>"$FAKE_DIR/npm.log"
case "$1 $2" in
    "install -g")
        echo npm-install >>"$FAKE_DIR/order.log"
        n=$(($(cat "$FAKE_DIR/npm.count" 2>/dev/null || echo 0) + 1))
        echo "$n" >"$FAKE_DIR/npm.count"
        if [ -n "${FAKE_NPM_FAIL:-}" ] || { [ -n "${FAKE_NPM_FAIL_FIRST:-}" ] && [ "$n" -eq 1 ]; }; then
            echo "npm error code E503" >&2
            echo "npm error 503 Service Unavailable - GET https://pkgs.dev.azure.com/hmcts/Artifacts" >&2
            exit 1
        fi
        [ -n "${FAKE_NPM_EMPTY:-}" ] && { echo "added 1 package in 1s"; exit 0; }
        mkdir -p "$FAKE_DIR/npm-prefix/bin"
        cp "$FAKE_DIR/hai-template" "$FAKE_DIR/npm-prefix/bin/hai"
        chmod +x "$FAKE_DIR/npm-prefix/bin/hai"
        echo "added 1 package in 1s" ;;
    "prefix -g") echo "$FAKE_DIR/npm-prefix" ;;
    "ls -g") printf '/usr/lib\n`-- @hmcts-cft/hai-cli@9.9.9\n' ;;
esac
exit 0
EOF

    # The client every hub call goes through. cft-workspace keeps scripts/agent-hub as a shim over the installed
    # one, which is the copy the entrypoint prefers, so this is written there; client-on-path moves it.
    cat >"$F/client" <<EOF
#!/bin/sh
REAL_SLEEP="$REAL_SLEEP"
EOF
    cat >>"$F/client" <<'EOF'
case "$1 $2" in
    "virtual status") shift 2; echo "$*" >>"$FAKE_DIR/hub.log" ;;
    "virtual cache-sync") [ "${3:-}" = --once ] || exec "$REAL_SLEEP" 1000 ;;
    "virtual git-identity") echo git-identity >>"$FAKE_DIR/order.log"; exit "${FAKE_GIT_IDENTITY_RC:-0}" ;;
    "virtual watch-ports") echo $$ >"$FAKE_DIR/ports.pid"; exec "$REAL_SLEEP" 1000 ;;
    "virtual assistant-supervisor")
        n=$(($(cat "$FAKE_DIR/supervisor.count" 2>/dev/null || echo 0) + 1))
        echo "$n" >"$FAKE_DIR/supervisor.count"
        echo "supervisor $n" >>"$FAKE_DIR/order.log"
        echo $$ >"$FAKE_DIR/supervisor.pid"
        tmux new-session -d -s "c-0f8a6a1$n" -c "$PWD" -e AGENT_HUB_CONVERSATION_ID=x "$REAL_SLEEP 1000"
        if [ "$n" -eq 1 ] && [ -n "${FAKE_SUPERVISOR_EXIT_FIRST:-}" ]; then "$REAL_SLEEP" 1; exit 1; fi
        exec "$REAL_SLEEP" 1000 ;;
    "virtual atlassian-login")
        echo "$PPID" >>"$FAKE_DIR/atlassian.runs"
        [ -n "${FAKE_ATLASSIAN_HANG:-}" ] && { echo $$ >"$FAKE_DIR/atlassian.pid"; exec "$REAL_SLEEP" 1000; }
        exit "${FAKE_ATLASSIAN_RC:-0}" ;;
    "virtual credential") printf 'sk-ant-oat-fake' ;;
    "credentials get")
        [ "$3" = claude_md ] || { printf 'ABSKfake'; exit 0; }
        case "${FAKE_CLAUDE_MD:-missing}" in
            stored) cat "$FAKE_DIR/claude_md" ;;
            error) echo "agent-hub: GET /api/virtual/x/credentials/claude_md: 502" >&2; exit 1 ;;
            *) exit 4 ;;
        esac ;;
esac
exit 0
EOF
    cp "$F/client" "$W/scripts/agent-hub"

    # Five repos, one every FAKE_REPO_SECONDS, then FAKE_REPOS_RC; records its niceness and run count. The
    # workspace declares no clone step unless a case calls prepare_hook, so these are what runs.
    cat >"$W/scripts/bootstrap" <<EOF
#!/usr/bin/env bash
REAL_SLEEP="$REAL_SLEEP"
EOF
    cat >>"$W/scripts/bootstrap" <<'EOF'
echo "$(basename "$0") $(awk '{print $19}' /proc/$$/stat)" >>"$FAKE_DIR/repos.runs"
echo "Cloning into 5 paths (jobs=16)…"
"$REAL_SLEEP" 1000 &
echo $! >"$FAKE_DIR/repos.child"
for i in 1 2 3 4 5; do
    "$REAL_SLEEP" "${FAKE_REPO_SECONDS:-1}"
    printf 'OK  apps/fake/repo%s\n' "$i"
done
kill $! 2>/dev/null
exit "${FAKE_REPOS_RC:-0}"
EOF
    sed 's/Cloning into 5 paths/Syncing 5 repo(s)/' "$W/scripts/bootstrap" >"$W/scripts/sync"
    chmod +x "$F/bin/"* "$W/scripts/"* "$F/client"
}

# The workspace's own clone step, as cft-workspace declares it: five repositories, one every FAKE_REPO_SECONDS,
# writing repos-state itself — including the note= line the entrypoint must not touch — then FAKE_REPOS_RC.
prepare_hook() {
    cat >"$W/.devcontainer/virtual-agent/prepare-workspace.sh" <<EOF
#!/usr/bin/env bash
REAL_SLEEP="$REAL_SLEEP"
EOF
    cat >>"$W/.devcontainer/virtual-agent/prepare-workspace.sh" <<'EOF'
state() {
    printf 'state=%s\ndone=%s\ntotal=5\nupdated=now\nnote=the workspace says the repositories are %s\n' \
        "$1" "$2" "$1" >"$VIRTUAL_AGENT_STATE/repos-state.tmp"
    mv "$VIRTUAL_AGENT_STATE/repos-state.tmp" "$VIRTUAL_AGENT_STATE/repos-state"
}
# A step that is killed for memory or dies on an error it does not handle: it says nothing about how it ended,
# and FAKE_PREPARE_SILENT is one that dies before it has said anything at all.
[ -n "${FAKE_PREPARE_SILENT:-}" ] && exit 1
# First, before anything that forks: the entrypoint's first report is what reads it.
state cloning 0
echo "prepare-workspace $(awk '{print $19}' /proc/$$/stat)" >>"$FAKE_DIR/repos.runs"
[ -n "${FAKE_PREPARE_DIES:-}" ] && exit 1
"$REAL_SLEEP" 1000 &
echo $! >"$FAKE_DIR/repos.child"
for i in 1 2 3 4 5; do
    "$REAL_SLEEP" "${FAKE_REPO_SECONDS:-1}"
    state cloning "$i"
done
kill $! 2>/dev/null
if [ "${FAKE_REPOS_RC:-0}" = 0 ]; then state done 5; else state failed 5; fi
exit "${FAKE_REPOS_RC:-0}"
EOF
    chmod +x "$W/.devcontainer/virtual-agent/prepare-workspace.sh"
}

SETTINGS='{"crossSessionInbound":"accept","env":{"AGENT_HUB_AUTO_ENABLE":"true","KNOWLEDGE_SWEEP_CHILD":"1"}}'

# hai_argv <n>: the argv of the nth start, on one line.
hai_argv() { tr '\n' ' ' <"$F/hai.argv.$1" 2>/dev/null; }
hai_env() { grep -qxF "$2" "$F/hai.env.$1" 2>/dev/null; }
hai_env_has() { grep -qE "^$2=" "$F/hai.env.$1" 2>/dev/null; }

# transcript: a conversation for the workspace, which is what makes --continue apply.
transcript() {
    local dir
    dir="$T/$CASE/home/.claude/projects/$(printf '%s' "$W" | tr -c 'A-Za-z0-9' '-')"
    mkdir -p "$dir"
    printf '{}\n' >"$dir/session.jsonl"
}

# start [VAR=value…]: runs the entrypoint in the background as EP, against the case's workspace, as
# virtual-agent-boot runs it: the script out of this package and the workspace from the environment. START_PATH
# replaces the PATH the fakes are found on, for a case that needs something to be missing from it.
start() {
    env -i PATH="${START_PATH:-$F/bin:$PATH}" HOME="$T/$CASE/home" NVM_DIR=/nonexistent FAKE_DIR="$F" \
        VIRTUAL_AGENT_WORKSPACE="$W" AGENT_HUB_MODEL_ROUTE=own_licence "$@" bash "$ENTRYPOINT" >"$T/out" 2>&1 &
    EP=$!
}

alive() { [ -d "/proc/$1" ] && ! grep -q '^[0-9]* ([^)]*) Z' "/proc/$1/stat" 2>/dev/null; }
dead() { ! alive "$1"; }

# stop: SIGTERM, then the entrypoint's exit status (killed after 10s). The bound is $REAL_SLEEP: a watchdog that
# the faked backoff shortened would kill a pod that was still shutting down. Killing the subshell below leaves
# its sleep running, and anything still holding this script's stdout keeps the wrapper waiting on the pipe long
# after the script has exited, so it writes nowhere.
stop() {
    local watchdog rc
    kill -TERM "$EP" 2>/dev/null
    ("$REAL_SLEEP" 10 && kill -KILL "$EP" 2>/dev/null) >/dev/null 2>&1 &
    watchdog=$!
    wait "$EP"
    rc=$?
    kill "$watchdog" 2>/dev/null
    wait "$watchdog" 2>/dev/null
    return "$rc"
}

state_is() { grep -qx "state=$1" "$STATE/repos-state" 2>/dev/null; }
hub_has() { grep -qF "$1" "$F/hub.log" 2>/dev/null; }

# The cases below are a pod whose image predates hai, where the install is the only thing that provides one at
# all. They take the fake off PATH to arrange that, so they need a host with no hai of its own on the standard
# directories — a CI runner has none, a laptop may, and one there would resolve whether the install worked or not.
NO_HAI_PATH="/usr/local/bin:/usr/bin:/bin"
needs_no_hai() {
    if PATH="$NO_HAI_PATH" command -v hai >/dev/null 2>&1; then
        skip "hai is installed on $NO_HAI_PATH"
        return 1
    fi
    rm -f "$F/bin/hai"
    START_PATH="$F/bin:$NO_HAI_PATH"
}

case_first_boot() {
    setup first-boot
    start FAKE_REPO_SECONDS=1 FAKE_CLAUDE_EXIT_FIRST=1
    wait_for 10 test -f "$F/claude.log" && ok "should start Claude when the pod boots" || no "Claude did not start"
    grep -q '^start 1 state=cloning$' "$F/claude.log" && ok "should start Claude while the repositories are still cloning" || no "Claude did not start before the clone finished"
    wait_for 5 test -f "$F/hai.argv.1"
    [ "$(hai_argv 1)" = "--settings $SETTINGS --dangerously-skip-permissions " ] &&
        ok "should give hai the inline settings and bypass permissions when it starts a session" || no "hai argv: $(hai_argv 1)"
    [ "$(cat "$F/hai.pwd.1" 2>/dev/null)" = "$W" ] &&
        ok "should start the session in the workspace the environment names when it is not this script's own directory" || no "session cwd: $(cat "$F/hai.pwd.1" 2>/dev/null)"
    hai_env 1 "HAI_ROUTE=byol" && ok "should map own_licence to HAI_ROUTE=byol when that is the hub's route" || no "hai env: $(tr '\n' ' ' <"$F/hai.env.1" 2>/dev/null)"
    hai_env 1 "AGENT_HUB_MODEL_ROUTE=own_licence" && ok "should pass the hub's own_licence route on unrenamed when it hands over to hai" || no "AGENT_HUB_MODEL_ROUTE was rewritten"
    hai_env_has 1 CLAUDE_CODE_OAUTH_TOKEN && ok "should put the Claude token in hai's environment when the route is own_licence" || no "no CLAUDE_CODE_OAUTH_TOKEN"
    hai_env_has 1 AWS_BEARER_TOKEN_BEDROCK && no "the Bedrock key leaked into the own_licence route" || ok "should leave the Bedrock key out when the route is own_licence"
    hai_env 1 "HAI_IN_CONTAINER=1" && ok "should tell hai it is already in a container when it starts a session" || no "hai would start a container of its own: $(tr '\n' ' ' <"$F/hai.env.1" 2>/dev/null)"
    # Both markers, not just the one: the hub's pod template sets them too, but a pod still on an older
    # template has only what this file exports, and without HAI_NO_UPDATE every session self-updates.
    hai_env 1 "HAI_NO_UPDATE=1" && ok "should tell hai not to re-check its own version when it starts a session" || no "sessions would self-update: $(tr '\n' ' ' <"$F/hai.env.1" 2>/dev/null)"
    head -1 "$F/hub.log" 2>/dev/null | grep -q '^running Claude is ready; cloning repositories' &&
        ok "should report running with the clone's progress when Claude is up" || no "the first report is not running with the clone's progress"
    grep -q '^cloning$' "$F/hub.log" && no "still reports the cloning phase" || ok "should report no cloning phase of its own when the repositories are arriving"
    wait_for 30 state_is "done" && ok "should end repos-state done when the clone finishes cleanly" || no "repos-state never said done"
    grep -qx 'total=5' "$STATE/repos-state" && grep -qx 'done=5' "$STATE/repos-state" && ok "should count the repositories in repos-state while they arrive" || no "repos-state has the wrong counts"
    [ -f "$STATE/bootstrapped" ] && ok "should write the bootstrapped marker when a clean bootstrap finishes" || no "no bootstrapped marker"
    wait_for 10 hub_has 'running Claude is ready; repositories ready' && ok "should report the repositories ready when they have all arrived" || no "never reported repositories ready"
    wait_for 20 grep -q '^start 2 ' "$F/claude.log" && ok "should restart Claude when its session ends" || no "Claude was not restarted"
    [ "$(wc -l <"$F/repos.runs")" -eq 1 ] && ok "should start no second bootstrap when Claude restarts" || no "bootstrap ran $(wc -l <"$F/repos.runs") times"
    grep -qx 'bootstrap 10' "$F/repos.runs" && ok "should run the clone step nice'd when it starts it behind Claude" || no "bootstrap niceness: $(cat "$F/repos.runs")"
    grep -q 'OK  apps/fake/repo5' "$STATE/repos.log" && ok "should send the clone step's output to repos.log when it runs it" || no "repos.log lacks bootstrap output"
    wait_for 5 test -f "$F/ports.pid" && ok "should start the port watcher when the pod boots" || no "the port watcher was not started"
    ports=$(cat "$F/ports.pid" 2>/dev/null)
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
    [ -n "$ports" ] && wait_for 5 dead "$ports" && ok "should stop the port watcher when it gets SIGTERM" || no "the port watcher $ports is still running"

    printf 'npm-install\ngit-identity\nclaude 1\ngit-identity\nclaude 2\n' >"$T/expected"
    [ "$(grep -v '^supervisor' "$F/order.log" 2>/dev/null | head -5)" = "$(cat "$T/expected")" ] &&
        ok "should install hai before anything starts and set the git identity before each Claude start" ||
        no "order: $(tr '\n' ' ' <"$F/order.log" 2>/dev/null)"
    [ "$(grep -c '^install -g' "$F/npm.log" 2>/dev/null)" = 1 ] &&
        ok "should not install hai again when Claude restarts" || no "npm install ran $(grep -c '^install -g' "$F/npm.log" 2>/dev/null) times"
    grep -q 'install -g .*--@hmcts-cft:registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/ @hmcts-cft/hai-cli@latest' "$F/npm.log" &&
        ok "should install hai from the hmcts-lib feed with the registry scoped to @hmcts-cft" || no "npm install argv: $(head -1 "$F/npm.log" 2>/dev/null)"
    grep -q 'hai: installed hai-cli@9.9.9 from the hmcts-lib feed' "$T/out" &&
        ok "should log which hai the pod got when the install succeeds" || no "did not log the installed hai version"
}

case_bedrock_route() {
    setup bedrock-route
    start AGENT_HUB_MODEL_ROUTE=bedrock FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/hai.argv.1" && ok "should start Claude when the route is bedrock" || no "Claude did not start on the bedrock route"
    hai_env 1 "HAI_ROUTE=bedrock" && ok "should map bedrock to HAI_ROUTE=bedrock when that is the hub's route" || no "hai env: $(tr '\n' ' ' <"$F/hai.env.1" 2>/dev/null)"
    hai_env 1 "AWS_BEARER_TOKEN_BEDROCK=ABSKfake" && ok "should put the stored Bedrock key in hai's environment when the route is bedrock" || no "no Bedrock key in hai's environment"
    hai_env_has 1 CLAUDE_CODE_OAUTH_TOKEN && no "the Claude token leaked into the bedrock route" || ok "should leave the Claude token out when the route is bedrock"
    [ "$(hai_argv 1)" = "--settings $SETTINGS --dangerously-skip-permissions " ] &&
        ok "should give hai the same argv on the bedrock route as on any other" || no "hai argv: $(hai_argv 1)"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_legacy_gateway_route() {
    setup legacy-gateway-route
    start AGENT_HUB_MODEL_ROUTE=gateway FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/hai.argv.1" && ok "should start Claude when the route is the legacy gateway" || no "Claude did not start on the legacy gateway route"
    hai_env 1 "HAI_ROUTE=bedrock" && ok "should map the legacy gateway route to HAI_ROUTE=bedrock when the hub sends one" || no "hai env: $(tr '\n' ' ' <"$F/hai.env.1" 2>/dev/null)"
    hai_env 1 "AGENT_HUB_MODEL_ROUTE=bedrock" && ok "should report the legacy gateway route to the hub as bedrock when it normalises it" || no "AGENT_HUB_MODEL_ROUTE was not normalised"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_unknown_route() {
    setup unknown-route
    start AGENT_HUB_MODEL_ROUTE=nonsense FAKE_REPO_SECONDS=0.2
    wait_for 10 hub_has 'failed unknown AGENT_HUB_MODEL_ROUTE: nonsense' && ok "should fail the agent when the route is one it does not know" || no "an unknown route did not fail the agent"
    [ ! -f "$F/hai.argv.1" ] && ok "should start no session when the route is one it does not know" || no "hai was started on an unknown route"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

# The next two cases are a pod on a current image, which always has a hai before boot installs one: they are the
# only hai-install cases that leave $F/bin/hai in place, standing in for the image's copy. A blip first — one
# failure, then a feed that answers — which must recover rather than pin the pod to the image's copy. The
# interval retry() will wait is read off the line it logs; the wait itself is the faked sleep.
case_hai_install_blip_recovers() {
    setup hai-install-blip-recovers
    start FAKE_NPM_FAIL_FIRST=1 FAKE_REPO_SECONDS=0.2
    wait_for 10 grep -q 'the hai install failed (exit 1); retrying in 30s' "$T/out" &&
        ok "should retry a failed install when the image's hai would do" || no "the install was not retried"
    wait_for 10 grep -q 'hai: installed hai-cli@9.9.9 from the hmcts-lib feed' "$T/out" &&
        ok "should install from the feed on the second attempt when the first failed" || no "the install never succeeded"
    wait_for 10 test -f "$F/hai.argv.1" && ok "should start a session once the feed answers" || no "no session was started"
    grep -qF "keeps the image's" "$T/out" && no "a blip pinned the pod to the image's hai" || ok "should not pin the pod to the image's hai when the failure was a blip"
    hub_has "running the image's" && no "a blip was reported as a stale hai" || ok "should not report a stale hai when the failure was a blip"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

# A feed that stays down: the attempts are bounded, so boot accepts the image's copy rather than holding the pod
# at provisioning, and says which version it kept in the log and in the running detail. The two intervals it
# would have spent getting there are asserted as the lines retry() logs.
case_hai_install_falls_back() {
    setup hai-install-falls-back
    start FAKE_NPM_FAIL=1 FAKE_REPO_SECONDS=0.2
    wait_for 15 grep -qF "hai: installing from the hmcts-lib feed failed 3 times, so this pod keeps the image's hai-cli@9.9.9 for its whole lifetime: npm error code E503" "$T/out" &&
        ok "should name npm's reason and the version it keeps when the attempts are spent" || no "the fallback was not logged: $(grep -o 'hai: .*' "$T/out" 2>/dev/null | tail -1)"
    [ "$(grep -c '^install -g' "$F/npm.log" 2>/dev/null)" = 3 ] &&
        ok "should take the fallback only after HAI_INSTALL_TRIES attempts when the feed stays down" || no "install attempts: $(grep -c '^install -g' "$F/npm.log" 2>/dev/null)"
    grep -q 'the hai install failed (exit 1); retrying in 30s' "$T/out" && grep -q 'the hai install failed (exit 1); retrying in 60s' "$T/out" &&
        ok "should back off from 30s to 60s between the attempts it is allowed" || no "backoff: $(grep -o 'retrying in [0-9]*s' "$T/out" 2>/dev/null | tr '\n' ' ')"
    wait_for 10 test -f "$F/hai.argv.1" && ok "should carry on and start a session on the image's hai when the install is given up on" || no "no session was started after the failed installs"
    grep -q '^failed' "$F/hub.log" 2>/dev/null && no "the fallback failed the agent" || ok "should not fail the agent when it falls back to the image's hai"
    wait_for 15 hub_has "running the image's hai-cli@9.9.9, as the feed install failed" &&
        ok "should tell the owner which hai the pod kept when it falls back" || no "hub: $(grep '^running' "$F/hub.log" 2>/dev/null | tail -1)"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

# The installed copy lands in npm's global prefix, which is not on PATH, so a session starting at all is the
# entrypoint having put it there.
case_hai_installed_off_path() {
    setup hai-installed-off-path
    needs_no_hai || return 0
    start FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/hai.argv.1" &&
        ok "should put the installed hai on PATH for the session it starts when npm's prefix is not on it" || no "the session did not start from the installed hai"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

# A momentary feed outage, with nothing on PATH until the install provides one.
case_hai_install_retries() {
    setup hai-install-retries
    needs_no_hai || return 0
    start FAKE_NPM_FAIL_FIRST=1 FAKE_REPO_SECONDS=0.2
    wait_for 10 grep -q 'the hai install failed (exit 1); retrying in 30s' "$T/out" &&
        ok "should retry the install when the feed is briefly unavailable" || no "the install was not retried"
    grep -q '^failed' "$F/hub.log" 2>/dev/null && no "a retried install failure failed the agent" || ok "should not fail the agent when an install failure is retried"
    wait_for 10 test -f "$F/hai.argv.1" && ok "should carry on once the feed answers when the first install failed" || no "boot never got past the install"
    [ "$(grep -c '^install -g' "$F/npm.log" 2>/dev/null)" -ge 2 ] &&
        ok "should attempt the install again rather than give up when it fails with no hai to fall back to" || no "install attempts: $(grep -c '^install -g' "$F/npm.log" 2>/dev/null)"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

# The mirror of hai-install-falls-back: the same feed outage, with nothing to fall back to.
case_hai_install_keeps_failing() {
    setup hai-install-keeps-failing
    needs_no_hai || return 0
    start FAKE_NPM_FAIL=1 FAKE_REPO_SECONDS=0.2
    wait_for 10 grep -q 'hai: installing from the hmcts-lib feed failed: npm error code E503' "$T/out" &&
        ok "should name npm's reason when an install fails" || no "did not log npm's reason"
    wait_for 10 grep -q 'the hai install failed (exit 1); retrying in 30s' "$T/out" &&
        ok "should retry for ever when the install fails with no hai to fall back to" || no "the install was not retried"
    grep -q '^failed' "$F/hub.log" 2>/dev/null && no "a feed that stays down failed the agent" || ok "should not fail the agent when the feed stays down"
    [ ! -f "$F/claude.log" ] && ok "should start no session while hai cannot be installed at all" || no "a session was started without hai"
    stop && ok "should stop the entrypoint when it gets SIGTERM while the install is still being retried" || no "the entrypoint did not stop on SIGTERM"
}

# The one install failure that is reported rather than retried: retrying it would only produce the same success.
case_hai_install_leaves_no_binary() {
    setup hai-install-leaves-no-binary
    needs_no_hai || return 0
    start FAKE_NPM_EMPTY=1 FAKE_REPO_SECONDS=0.2
    wait_for 10 hub_has 'failed installing hai reported success but no hai binary could be found' &&
        ok "should fail the agent when an install reports success and leaves no binary" || no "an install that leaves no binary did not fail the agent"
    [ "$(grep -c '^install -g' "$F/npm.log" 2>/dev/null)" = 1 ] &&
        ok "should not retry an install that reported success and left no binary" || no "install attempts: $(grep -c '^install -g' "$F/npm.log" 2>/dev/null)"
    [ ! -f "$F/claude.log" ] && ok "should start no session when the install left no binary" || no "a session was started without hai"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_continues_a_conversation() {
    setup continues-a-conversation
    transcript
    start FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/hai.argv.1" && ok "should start Claude when the project already has a conversation" || no "Claude did not start"
    [ "$(hai_argv 1)" = "--settings $SETTINGS --dangerously-skip-permissions --continue " ] &&
        ok "should continue the existing conversation when the project has one" || no "hai argv: $(hai_argv 1)"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_git_identity_fails() {
    setup git-identity-fails
    start FAKE_GIT_IDENTITY_RC=1 FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/claude.log" && ok "should start Claude when the git identity cannot be set" || no "Claude did not start after git-identity failed"
    grep -q 'git: could not set the git identity; keeping the current one' "$T/out" && ok "should log that the git identity was not set when it fails" || no "did not log the git-identity failure"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_later_boot_fails() {
    setup later-boot-fails
    mkdir -p "$STATE"
    echo yesterday >"$STATE/bootstrapped"
    start FAKE_REPO_SECONDS=0.2 FAKE_REPOS_RC=1
    wait_for 20 state_is failed && ok "should leave repos-state failed when the sync fails" || no "repos-state never said failed"
    grep -qx 'sync 10' "$F/repos.runs" && ok "should run sync when the volume has been bootstrapped before" || no "did not run sync: $(cat "$F/repos.runs" 2>/dev/null)"
    head -1 "$F/hub.log" 2>/dev/null | grep -q '^running Claude is ready; syncing repositories' && ok "should report the sync's progress when it is syncing" || no "did not report syncing"
    wait_for 10 hub_has 'running Claude is ready; some repositories failed to sync' && ok "should report the failure in the detail when the sync fails" || no "did not report the failure"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_sigterm_mid_clone() {
    setup sigterm-mid-clone
    start FAKE_REPO_SECONDS=30
    wait_for 10 test -f "$F/repos.child" && wait_for 10 test -f "$F/claude.log"
    child=$(cat "$F/repos.child" 2>/dev/null)
    stop && ok "should stop the entrypoint when it gets SIGTERM mid-clone" || no "the entrypoint did not stop on SIGTERM mid-clone"
    wait_for 5 dead "$child" && ok "should stop the clone step and its children when it gets SIGTERM" || no "the clone's child $child is still running"
    [ ! -f "$STATE/bootstrapped" ] && ok "should write no bootstrapped marker when the bootstrap is interrupted" || no "an interrupted bootstrap wrote the marker"
    grep -q "clone step" "$T/out" && ok "should log that it stopped the clone step when it gets SIGTERM" || no "did not log the clone stop"
}

DEFAULT_CLAUDE_MD="You are running in a pod in Preview and connected via the agent hub."
same() { [ -f "$2" ] && [ "$(od -c <"$1")" = "$(od -c <"$2")" ]; }

case_claude_md_stored() {
    setup claude-md-stored
    printf '  # Olive\n\nI work on PCS.\n\n\tIndented, trailing spaces  \n\n' >"$F/claude_md"
    start FAKE_CLAUDE_MD=stored FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/claude_md.seen.1" && ok "should write CLAUDE.md before Claude starts when the owner stored one" || no "Claude started without a CLAUDE.md"
    same "$F/claude_md" "$F/claude_md.seen.1" && ok "should write the stored CLAUDE.md exactly, blank lines and trailing newlines kept" || no "CLAUDE.md differs from the stored text"
    [ "$(stat -c %a "$T/$CASE/home/.claude/CLAUDE.md")" = 600 ] && ok "should write CLAUDE.md mode 0600 when it writes one" || no "CLAUDE.md mode is $(stat -c %a "$T/$CASE/home/.claude/CLAUDE.md")"
    leftover=$(find "$T/$CASE/home/.claude" -name 'CLAUDE.md.*')
    [ -z "$leftover" ] && ok "should leave no temporary file behind when it writes CLAUDE.md" || no "a temporary file was left behind: $leftover"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_claude_md_missing() {
    setup claude-md-missing
    start FAKE_CLAUDE_MD=missing FAKE_REPO_SECONDS=0.2
    printf '%s' "$DEFAULT_CLAUDE_MD" >"$T/expected"
    wait_for 10 test -f "$F/claude_md.seen.1" && same "$T/expected" "$F/claude_md.seen.1" &&
        ok "should write the default CLAUDE.md when the hub has none stored" || no "the default was not written: $(cat "$F/claude_md.seen.1" 2>/dev/null)"
    grep -q 'claude_md: wrote the default CLAUDE.md' "$T/out" && ok "should log that it wrote the default when the hub has none stored" || no "did not log the default"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_claude_md_error() {
    setup claude-md-error
    mkdir -p "$T/$CASE/home/.claude"
    printf 'the last one\n' >"$T/$CASE/home/.claude/CLAUDE.md"
    cp "$T/$CASE/home/.claude/CLAUDE.md" "$T/expected"
    start FAKE_CLAUDE_MD=error FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/claude_md.seen.1" && same "$T/expected" "$F/claude_md.seen.1" &&
        ok "should keep the existing CLAUDE.md and start Claude anyway when the hub errors" || no "the existing CLAUDE.md was not kept"
    grep -q 'could not read the claude_md credential (exit 1); keeping' "$T/out" && ok "should log that it kept the existing file when the hub errors" || no "did not log keeping the file"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_claude_md_restart() {
    setup claude-md-restart
    printf 'first\n' >"$F/claude_md"
    start FAKE_CLAUDE_MD=stored FAKE_CLAUDE_EXIT_FIRST=1 FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/claude_md.seen.1"
    printf 'second\nwith two lines\n' >"$F/claude_md"
    wait_for 20 test -f "$F/claude_md.seen.2" && same "$F/claude_md" "$F/claude_md.seen.2" &&
        ok "should fetch and rewrite CLAUDE.md before Claude restarts when the owner has replaced it" || no "the restart did not get the new CLAUDE.md"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

fake_twg() { printf '#!/bin/sh\nexit 0\n' >"$F/bin/twg" && chmod +x "$F/bin/twg"; }

# SIGTERM stopping a sign-in that is still going is atlassian-sigterm's, where the fake twg genuinely hangs:
# here the retries are spent in the time the asserts take, so a pid test would pass whatever SIGTERM did.
case_atlassian_fails() {
    setup atlassian-fails
    fake_twg
    start FAKE_ATLASSIAN_RC=1 FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/claude.log" && ok "should start Claude when the Atlassian sign-in fails" || no "Claude did not start after atlassian-login failed"
    wait_for 5 grep -q 'atlassian sign-in failed (exit 1); retrying in 60s' "$T/out" && ok "should log the failure and retry later when the Atlassian sign-in fails" || no "did not log the atlassian failure"
    wait_for 10 grep -q 'atlassian sign-in failed (exit 1); retrying in 120s' "$T/out" &&
        ok "should double the interval between the sign-in attempts when it keeps failing" || no "backoff: $(grep -o 'atlassian sign-in failed (exit 1); retrying in [0-9]*s' "$T/out" 2>/dev/null | tr '\n' ' ')"
    wait_for 10 grep -q 'atlassian sign-in failed 3 times; Jira and Confluence stay unconfigured until the next boot' "$T/out" &&
        ok "should give up after ATLASSIAN_TRIES attempts when the sign-in keeps failing" || no "did not give up: $(grep -o 'atlassian.*' "$T/out" 2>/dev/null | tail -1)"
    [ "$(wc -l <"$F/atlassian.runs")" -eq 3 ] && ok "should run the sign-in ATLASSIAN_TRIES times when each attempt fails" || no "atlassian-login ran $(wc -l <"$F/atlassian.runs") times"
    grep -q '^failed' "$F/hub.log" && no "a failed Atlassian sign-in failed the agent" || ok "should not fail the agent when the Atlassian sign-in fails"
    stop && ok "should stop the entrypoint when it gets SIGTERM after the sign-in has given up" || no "the entrypoint did not stop on SIGTERM"
}

case_atlassian_not_signed_in() {
    setup atlassian-not-signed-in
    fake_twg
    start FAKE_ATLASSIAN_RC=4 FAKE_REPO_SECONDS=30
    wait_for 10 test -f "$F/claude.log" && ok "should start Claude when the owner does not complete the Atlassian sign-in" || no "Claude did not start"
    wait_for 5 grep -q 'atlassian: not signed in; Jira and Confluence stay unconfigured until the next boot' "$T/out" &&
        ok "should log that Atlassian stays signed out when the owner does not complete it" || no "did not log the unfinished sign-in"
    wait_for 15 sh -c "[ \$(grep -c '^running' '$F/hub.log') -ge 2 ]" && ok "should report running again once the sign-in is over" || no "running was not reported again"
    [ "$(wc -l <"$F/atlassian.runs")" -eq 1 ] && ok "should not relay an unfinished sign-in again in the same boot" || no "atlassian-login ran $(wc -l <"$F/atlassian.runs") times"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_atlassian_sigterm() {
    setup atlassian-sigterm
    fake_twg
    start FAKE_ATLASSIAN_HANG=1 FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/atlassian.pid" && wait_for 10 test -f "$F/claude.log" &&
        ok "should start Claude while the Atlassian sign-in waits for the owner" || no "Claude did not start during the sign-in"
    signin=$(cat "$F/atlassian.pid" 2>/dev/null)
    stop && ok "should stop the entrypoint when it gets SIGTERM during the sign-in" || no "the entrypoint did not stop on SIGTERM"
    [ -n "$signin" ] && wait_for 5 dead "$signin" && ok "should stop the Atlassian sign-in when it gets SIGTERM" || no "the sign-in $signin is still running"
}

case_atlassian_no_twg() {
    setup atlassian-no-twg
    if command -v twg >/dev/null; then
        skip "twg is installed on this host, so the sign-in cannot be absent"
        return 0
    fi
    start FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/claude.log" && grep -q 'atlassian: twg is not installed' "$T/out" &&
        ok "should skip the sign-in when twg is not installed" || no "did not skip the sign-in without twg"
    [ ! -f "$F/atlassian.runs" ] && ok "should run no atlassian-login when twg is not installed" || no "atlassian-login ran without twg"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_conversations() {
    setup conversations
    printf 'mine\n' >"$F/claude_md"
    start FAKE_SUPERVISOR_EXIT_FIRST=1 FAKE_CLAUDE_MD=stored FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/claude.log" && ok "should start the main Claude session when the pod boots" || no "Claude did not start"
    wait_for 10 test -f "$F/supervisor.count" && ok "should start the conversation supervisor beside the main session when the pod boots" || no "the supervisor did not start"
    wait_for 5 hub_has 'running Claude is ready' && ok "should report running when both are started" || no "did not report running"
    printf 'npm-install\ngit-identity\n' >"$T/expected"
    [ "$(head -2 "$F/order.log" 2>/dev/null)" = "$(cat "$T/expected")" ] &&
        ok "should install hai and set the git identity before either session starts" || no "order: $(tr '\n' ' ' <"$F/order.log" 2>/dev/null)"
    same "$F/claude_md" "$F/claude_md.seen.1" && ok "should write the stored CLAUDE.md when the supervisor starts too" || no "CLAUDE.md differs from the stored text"
    wait_for 20 grep -qx 2 "$F/supervisor.count" && ok "should restart the supervisor when it exits" || no "the supervisor was not restarted"
    grep -q 'the conversation supervisor exited (exit 1); restarting in 5s' "$T/out" && ok "should log the supervisor's exit when it is restarted" || no "did not log the supervisor's exit"
    [ "$(cat "$F/claude.count" 2>/dev/null)" = 1 ] && ok "should keep the main session running when the supervisor restarts" || no "Claude started $(cat "$F/claude.count" 2>/dev/null) times"
    supervisor=$(cat "$F/supervisor.pid" 2>/dev/null)
    main=$(cat "$F/tmux.claude.pid" 2>/dev/null)
    conversations=$(cat "$F"/tmux.c-*.pid 2>/dev/null)
    [ "$(echo "$conversations" | wc -w)" -eq 2 ] && ok "should run conversation sessions in c-* tmux sessions when the supervisor starts them" || no "conversation sessions: $conversations"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
    [ -n "$supervisor" ] && wait_for 5 dead "$supervisor" && ok "should stop the supervisor when it gets SIGTERM" || no "the supervisor $supervisor is still running"
    gone=1
    for pid in $conversations; do wait_for 5 dead "$pid" || gone=0; done
    [ "$gone" -eq 1 ] && ok "should kill the c-* tmux sessions when it gets SIGTERM" || no "a conversation session is still running"
    [ -n "$main" ] && wait_for 5 dead "$main" && ok "should kill the main claude session when it gets SIGTERM" || no "the main session $main is still running"
}

# The workspace that declares its own clone step, which is the shape every checkout has once cft-workspace
# carries prepare-workspace.sh: this file starts it and reads its progress back, and knows nothing about what
# it clones or where.
case_prepare_workspace() {
    setup prepare-workspace
    prepare_hook
    start FAKE_REPO_SECONDS=1
    wait_for 10 test -f "$F/claude.log" && ok "should start Claude when the workspace declares a clone step" || no "Claude did not start"
    grep -q '^start 1 state=cloning$' "$F/claude.log" && ok "should start Claude while the declared clone step is still running" || no "Claude did not start before the clone step finished"
    grep -q "running the workspace's clone step" "$T/out" && ok "should log that it ran the workspace's clone step when the workspace declares one" || no "did not log the clone step"
    grep -qx 'prepare-workspace 10' "$F/repos.runs" && ok "should run the declared clone step nice'd behind Claude" || no "clone step niceness: $(cat "$F/repos.runs" 2>/dev/null)"
    grep -q '^bootstrap' "$F/repos.runs" && no "ran the workspace's bootstrap as well as the hook" || ok "should run no bootstrap or sync of its own when the workspace declares a clone step"
    # The counts come from the file the clone step wrote: nothing here counts anything itself. The first report
    # is the one that carries them, because progress is reported at most every REPORT_EVERY real seconds while
    # the repositories are arriving, and that gate is on the clock rather than on a sleep.
    wait_for 10 hub_has 'running Claude is ready; cloning repositories (0/5)' &&
        ok "should report the progress the clone step writes when it is still running" || no "hub: $(grep '^running' "$F/hub.log" 2>/dev/null | tail -1)"
    wait_for 15 state_is "done" && ok "should reach done when the clone step says so" || no "repos-state never said done"
    wait_for 10 hub_has 'running Claude is ready; repositories ready' && ok "should report the repositories ready when the clone step is done" || no "never reported repositories ready"
    grep -q '^note=the workspace says the repositories are done$' "$STATE/repos-state" &&
        ok "should leave the clone step's note= line alone when it reads its progress" || no "repos-state: $(cat "$STATE/repos-state" 2>/dev/null | tr '\n' ' ')"
    [ ! -f "$STATE/bootstrapped" ] && ok "should write no bootstrapped marker when the clone step owns which of the two it runs" || no "wrote a marker the clone step owns"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_prepare_workspace_fails() {
    setup prepare-workspace-fails
    prepare_hook
    # Long enough that the first poll sees the clone step running: which of the two it was doing is only ever
    # said in state=, and the failure detail names it.
    start FAKE_REPO_SECONDS=1 FAKE_REPOS_RC=1
    wait_for 15 state_is failed && ok "should leave repos-state failed when the clone step fails" || no "repos-state never said failed"
    wait_for 10 hub_has 'running Claude is ready; some repositories failed to clone' &&
        ok "should report the failure in the detail when the clone step fails" || no "hub: $(grep '^running' "$F/hub.log" 2>/dev/null | tail -1)"
    grep -q "the workspace's clone step reported failures" "$T/out" && ok "should log that the clone step failed when it exits non-zero" || no "did not log the failure"
    grep -q '^note=the workspace says the repositories are failed$' "$STATE/repos-state" &&
        ok "should leave the clone step's own wording for a failure alone when it reads the state" || no "repos-state: $(cat "$STATE/repos-state" 2>/dev/null | tr '\n' ' ')"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

# A clone step that stops without saying how it ended. The state it leaves is what every session for the rest
# of the pod's life is told, so correcting the hub's detail is not enough: the file has to say failed too, and
# without the step's note=, which was written for a clone that was still running.
case_prepare_workspace_dies() {
    setup prepare-workspace-dies
    prepare_hook
    start FAKE_PREPARE_DIES=1
    wait_for 15 state_is failed && ok "should write failed when the clone step stops without saying how it ended" || no "repos-state: $(cat "$STATE/repos-state" 2>/dev/null | tr '\n' ' ')"
    grep -q '^note=' "$STATE/repos-state" && no "kept the clone step's note for a step that is no longer running" ||
        ok "should drop the clone step's note when it takes the step as failed, so the client words it instead"
    grep -q "without finishing" "$T/out" && ok "should log that the clone step said nothing about how it ended" || no "did not log the unfinished state: $(grep -o "clone step.*" "$T/out" | tail -1)"
    wait_for 10 hub_has 'running Claude is ready; some repositories failed to clone' &&
        ok "should report the failure in the detail when the clone step stops without saying how it ended" || no "hub: $(grep '^running' "$F/hub.log" 2>/dev/null | tail -1)"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

# The same, for a step that dies before its first write, on a volume the last boot left state=done on: that
# state is a lie about this boot, and a session reading it is told nothing at all.
case_prepare_workspace_dies_silently() {
    setup prepare-workspace-dies-silently
    prepare_hook
    mkdir -p "$STATE"
    printf 'state=done\ndone=5\ntotal=5\nupdated=yesterday\nnote=the last boot cloned them all\n' >"$STATE/repos-state"
    start FAKE_PREPARE_SILENT=1
    wait_for 15 state_is failed && ok "should write failed when the clone step dies before it writes anything" || no "repos-state: $(cat "$STATE/repos-state" 2>/dev/null | tr '\n' ' ')"
    grep -q '^note=' "$STATE/repos-state" && no "kept the last boot's note" || ok "should drop the last boot's note when this boot's clone step dies"
    wait_for 10 hub_has 'running Claude is ready; some repositories failed to arrive' &&
        ok "should report the failure as neither a clone nor a sync when the step never said which it was doing" || no "hub: $(grep '^running' "$F/hub.log" 2>/dev/null | tail -1)"
    hub_has 'repositories ready' && no "reported the last boot's success as this boot's" || ok "should not report the last boot's success when this boot's clone step dies"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

case_prepare_workspace_sigterm() {
    setup prepare-workspace-sigterm
    prepare_hook
    start FAKE_REPO_SECONDS=30
    wait_for 10 test -f "$F/repos.child" && wait_for 10 test -f "$F/claude.log"
    child=$(cat "$F/repos.child" 2>/dev/null)
    stop && ok "should stop the entrypoint when it gets SIGTERM while the clone step runs" || no "the entrypoint did not stop on SIGTERM"
    wait_for 5 dead "$child" && ok "should stop the declared clone step and its children when it gets SIGTERM" || no "the clone step's child $child is still running"
}

# The shape a workspace has that declares no clone step at all, which is neither the hook nor the two scripts.
case_no_clone_step() {
    setup no-clone-step
    rm -f "$W/scripts/bootstrap" "$W/scripts/sync"
    start
    wait_for 10 test -f "$F/hai.argv.1" && ok "should start Claude when the workspace has nothing to clone" || no "Claude did not start"
    grep -q 'declares no clone step' "$T/out" && ok "should log that the workspace declares no clone step when it has none" || no "did not log the missing clone step"
    wait_for 10 hub_has 'running Claude is ready' && ok "should report running without any repository progress when there is no clone step" || no "hub: $(cat "$F/hub.log" 2>/dev/null | tr '\n' ' ')"
    [ ! -f "$STATE/repos-state" ] && ok "should write no repos-state when nothing is cloning, so a session is told nothing about repositories" || no "repos-state: $(cat "$STATE/repos-state" 2>/dev/null | tr '\n' ' ')"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

# The client is the installed one unless the workspace has a shim that runs, which is the precedence
# virtual-agent-boot uses.
case_client_on_path() {
    setup client-on-path
    rm -f "$W/scripts/agent-hub"
    cp "$F/client" "$F/bin/agent-hub"
    start FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/claude.log" && ok "should start Claude when the only client is the one on PATH" || no "Claude did not start"
    wait_for 10 hub_has 'running Claude is ready' && ok "should reach the hub through the client on PATH when the workspace has no shim" || no "hub: $(cat "$F/hub.log" 2>/dev/null | tr '\n' ' ')"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

# A volume may hold a checkout whose shim needs an install nothing has done. Preferring it would take every hub
# call with it, so the working installed client has to win.
case_broken_workspace_shim() {
    setup broken-workspace-shim
    printf '#!/bin/sh\necho "agent-hub: cannot find module" >&2\nexit 127\n' >"$W/scripts/agent-hub"
    chmod +x "$W/scripts/agent-hub"
    cp "$F/client" "$F/bin/agent-hub"
    start FAKE_REPO_SECONDS=0.2
    wait_for 10 test -f "$F/claude.log" && ok "should start Claude when the workspace shim cannot run" || no "Claude did not start"
    wait_for 10 hub_has 'running Claude is ready' && ok "should fall through to the client on PATH when the workspace shim cannot run" || no "hub: $(cat "$F/hub.log" 2>/dev/null | tr '\n' ' ')"
    stop && ok "should stop the entrypoint when it gets SIGTERM" || no "the entrypoint did not stop on SIGTERM"
}

run_case() {
    case "$1" in
        first-boot) case_first_boot ;;
        bedrock-route) case_bedrock_route ;;
        legacy-gateway-route) case_legacy_gateway_route ;;
        unknown-route) case_unknown_route ;;
        hai-install-blip-recovers) case_hai_install_blip_recovers ;;
        hai-install-falls-back) case_hai_install_falls_back ;;
        hai-installed-off-path) case_hai_installed_off_path ;;
        hai-install-retries) case_hai_install_retries ;;
        hai-install-keeps-failing) case_hai_install_keeps_failing ;;
        hai-install-leaves-no-binary) case_hai_install_leaves_no_binary ;;
        continues-a-conversation) case_continues_a_conversation ;;
        git-identity-fails) case_git_identity_fails ;;
        later-boot-fails) case_later_boot_fails ;;
        sigterm-mid-clone) case_sigterm_mid_clone ;;
        claude-md-stored) case_claude_md_stored ;;
        claude-md-missing) case_claude_md_missing ;;
        claude-md-error) case_claude_md_error ;;
        claude-md-restart) case_claude_md_restart ;;
        atlassian-fails) case_atlassian_fails ;;
        atlassian-not-signed-in) case_atlassian_not_signed_in ;;
        atlassian-sigterm) case_atlassian_sigterm ;;
        atlassian-no-twg) case_atlassian_no_twg ;;
        conversations) case_conversations ;;
        prepare-workspace) case_prepare_workspace ;;
        prepare-workspace-fails) case_prepare_workspace_fails ;;
        prepare-workspace-dies) case_prepare_workspace_dies ;;
        prepare-workspace-dies-silently) case_prepare_workspace_dies_silently ;;
        prepare-workspace-sigterm) case_prepare_workspace_sigterm ;;
        no-clone-step) case_no_clone_step ;;
        client-on-path) case_client_on_path ;;
        broken-workspace-shim) case_broken_workspace_shim ;;
        *) printf 'unknown case %s (try --list)\n' "$1" >&2; exit 2 ;;
    esac
}

[ $# -gt 0 ] || { printf 'a case name is required: %s\n' "${CASES[*]}" >&2; exit 2; }
for name in "$@"; do run_case "$name"; done

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
