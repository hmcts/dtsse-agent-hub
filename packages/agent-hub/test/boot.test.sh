#!/usr/bin/env bash
# bin/virtual-agent-boot against a mock hub, fake gh, git and sleep, and the package's own client
# installed as npm installs it. One case per run, because every case wants a virtual agent whose
# status, prompts and completes start empty.
#
# src/virtual-agent-boot.test.ts drives it, and owns the mock hub:
#
#   HUB_URL=http://127.0.0.1:1234 HUB_STATE=/tmp/hub.json bash test/boot.test.sh no-token
#   bash test/boot.test.sh --list          # the case names, which is what the wrapper iterates
#
# HUB_URL and HUB_STATE are required: the hub answers on the first and rewrites the second
# ({status, prompts, completes, github}) after every request it serves. VID and LAUNCH name the
# virtual agent it minted the launch token for. BOOT is the script under test and AGENT_HUB_CLI_JS
# the client's CLI, so both can be pointed elsewhere.

# ok and no always succeed, so `test && ok || no` never runs both; the fakes expand $FAKE_DIR when they run.
# shellcheck disable=SC2015,SC2016
set -u

CASES=(no-token refused-token stored-token-no-access checkout-client broken-checkout-client no-client trailing-slash)

if [ "${1:-}" = "--list" ]; then
    printf '%s\n' "${CASES[@]}"
    exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BOOT="${BOOT:-$ROOT/bin/virtual-agent-boot}"
CLIENT="$ROOT/bin/agent-hub"
# node strips the types, so the suite does not depend on a build having run first.
CLI_JS="${AGENT_HUB_CLI_JS:-$ROOT/src/cli.ts}"
HUB_URL="${HUB_URL:?HUB_URL is not set: src/virtual-agent-boot.test.ts starts the mock hub}"
# An apostrophe in a ${var:?message} is a quote to bash, even inside double quotes, so there is none here.
HUB_STATE="${HUB_STATE:?HUB_STATE is not set: src/virtual-agent-boot.test.ts writes the hub state there}"
VID="${VID:-va-boot-1}"
LAUNCH="${LAUNCH:-launch-boot-test}"
REAL_GIT="$(command -v git)"
REAL_SLEEP="$(command -v sleep)"
REAL_NODE="$(command -v node)"
T="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT

# Not a real credential: what the fake gh hands back, and what the hub should end up holding.
GOOD_TOKEN="gh-boot-test-token"
STALE_TOKEN="gh-boot-test-stale"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
no() {
    fail=$((fail + 1))
    printf 'FAIL %s: %s\n' "$CASE" "$1"
    for f in "$C/out" "$C/order.log" "$HUB_STATE"; do
        [ -f "$f" ] && sed "s#^#     $(basename "$f") | #" "$f"
    done
}

setup() {
    CASE="$1"
    C="$T/$1"
    mkdir -p "$C/bin" "$C/home"
    : >"$C/order.log"

    cat >"$C/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
    "auth login")
        if [[ " $* " == *" --with-token "* ]]; then
            read -r token
            [ "$token" = "$FAKE_GOOD_TOKEN" ] || { echo "error validating token: HTTP 401: Bad credentials" >&2; exit 1; }
            echo "gh login-with-token" >>"$FAKE_DIR/order.log"
        else
            [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] && { echo "GH_TOKEN reached gh auth login" >&2; exit 1; }
            printf '\n! First copy your one-time code: 7B7F-C198\nOpen this URL to continue in your web browser: https://github.com/login/device\n' >&2
            echo "gh device-login" >>"$FAKE_DIR/order.log"
        fi
        touch "$FAKE_DIR/gh.signed-in" ;;
    "auth setup-git") echo "gh setup-git" >>"$FAKE_DIR/order.log" ;;
    "auth token") [ -f "$FAKE_DIR/gh.signed-in" ] && printf '%s\n' "$FAKE_GOOD_TOKEN" ;;
    "api user") echo octocat ;;
esac
EOF

    # Clones only once gh has signed in, like an internal repo over HTTPS; FAKE_CLONE_DENIED
    # clones answer "Repository not found" first, as GitHub does for an account without access.
    cat >"$C/bin/git" <<EOF
#!/usr/bin/env bash
REAL_GIT="$REAL_GIT"
EOF
    cat >>"$C/bin/git" <<'EOF'
case "$1" in
    config) exec "$REAL_GIT" "$@" ;;
    clone)
        echo "git clone" >>"$FAKE_DIR/order.log"
        if [ ! -f "$FAKE_DIR/gh.signed-in" ]; then
            echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2
            exit 128
        fi
        denied=$(cat "$FAKE_DIR/denied" 2>/dev/null || echo "${FAKE_CLONE_DENIED:-0}")
        if [ "$denied" -gt 0 ]; then
            echo $((denied - 1)) >"$FAKE_DIR/denied"
            printf "remote: Repository not found.\nfatal: repository 'https://github.com/hmcts/cft-workspace.git/' not found\n" >&2
            exit 128
        fi
        dest="${*: -1}"
        mkdir -p "$dest/.git" "$dest/.devcontainer/virtual-agent"
        printf '#!/bin/sh\necho entrypoint >>"$FAKE_DIR/order.log"\n' >"$dest/.devcontainer/virtual-agent/entrypoint.sh"
        chmod +x "$dest/.devcontainer/virtual-agent/entrypoint.sh" ;;
    -C)
        case "$3" in
            fetch) echo "git fetch" >>"$FAKE_DIR/order.log" ;;
            rev-parse) echo master ;;
            symbolic-ref) echo origin/master ;;
            merge) echo "git merge" >>"$FAKE_DIR/order.log" ;;
        esac ;;
esac
EOF
    printf '#!/bin/sh\nexec "%s" 0.05\n' "$REAL_SLEEP" >"$C/bin/sleep"
    # node is on PATH through the case's own bin directory, so dropping the client (no-client) does
    # not also drop node, and nothing the machine happens to have installed globally stands in for it.
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$REAL_NODE" >"$C/bin/node"
    chmod +x "$C/bin/gh" "$C/bin/git" "$C/bin/sleep" "$C/bin/node"
    # npm links a package's bin into the global bin directory, so the client runs from a symlink.
    ln -s "$CLIENT" "$C/bin/agent-hub"
}

# seed_github TOKEN: the GitHub token the owner stored on the hub before the pod booted.
seed_github() {
    curl -sS -o /dev/null -X PUT -H "Authorization: Bearer $LAUNCH" -H 'Content-Type: application/json' \
        --data-binary "{\"value\":\"$1\"}" "$HUB_URL/api/virtual/$VID/credentials/github"
}

# boot [VAR=value…]: runs the boot script to its end (the fake entrypoint exits), at most 30s.
boot() {
    env -i PATH="$C/bin:/usr/bin:/bin" HOME="$C/home" NVM_DIR=/nonexistent FAKE_DIR="$C" \
        FAKE_GOOD_TOKEN="$GOOD_TOKEN" AGENT_HUB_URL="$HUB_URL" AGENT_HUB_VIRTUAL_AGENT_ID="$VID" \
        AGENT_HUB_LAUNCH_TOKEN="$LAUNCH" AGENT_HUB_CLI_JS="$CLI_JS" VIRTUAL_AGENT_WORKSPACE="$C/ws/cft-workspace" \
        "$@" bash "$BOOT" >"$C/out" 2>&1 &
    local pid=$! watchdog
    # Killing the subshell below leaves its sleep running, and anything still holding this script's
    # stdout keeps the wrapper waiting on the pipe long after the script has exited, so it writes nowhere.
    ("$REAL_SLEEP" 30 && kill -KILL "$pid" 2>/dev/null) >/dev/null 2>&1 &
    watchdog=$!
    wait "$pid"
    BOOT_RC=$?
    kill "$watchdog" 2>/dev/null
    wait "$watchdog" 2>/dev/null
}

order_is() { [ "$(tr '\n' ' ' <"$C/order.log")" = "$1" ]; }
hub() { jq -r "$@" "$HUB_STATE"; }

case_no_token() {
    setup no-token
    boot
    [ "$BOOT_RC" -eq 0 ] && ok "boots through to the entrypoint" || no "boot exited $BOOT_RC"
    order_is "gh device-login gh setup-git git clone entrypoint " && ok "signs in to GitHub before the clone" || no "order: $(tr '\n' ' ' <"$C/order.log")"
    grep -q "signing in to GitHub with $C/bin/agent-hub" "$C/out" && ok "uses the installed client with no checkout" || no "did not use the installed client"
    [ "$(hub '.status[1].phase')" = awaiting_credentials ] && hub '.status[1].detail' | grep -q '^github: no GitHub token stored' &&
        ok "reports awaiting_credentials for the missing token" || no "status: $(hub -c '.status')"
    [ "$(hub '.prompts[0].user_code')" = 7B7F-C198 ] && ok "relays the device code" || no "prompts: $(hub -c '.prompts')"
    [ "$(hub '.completes[0].account_label')" = octocat ] && ok "completes the login with the account" || no "completes: $(hub -c '.completes')"
    [ "$(hub '.github')" = "$GOOD_TOKEN" ] && ok "stores the token on the hub" || no "the token was not stored"
    hub '.status[].detail // empty' | grep -q 'cannot clone' && no "reported a clone failure" || ok "no clone failure reported"
}

case_refused_token() {
    setup refused-token
    seed_github "$STALE_TOKEN"
    boot
    [ "$BOOT_RC" -eq 0 ] && order_is "gh device-login gh setup-git git clone entrypoint " &&
        ok "a refused stored token falls back to the device-code sign-in" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    hub '.status[1].detail' | grep -q '^github: the stored GitHub token was refused' && ok "says the stored token was refused" || no "status: $(hub -c '.status')"
    [ "$(hub '.github')" = "$GOOD_TOKEN" ] && ok "replaces the token on the hub" || no "the token was not replaced"
}

case_stored_token_no_access() {
    setup stored-token-no-access
    seed_github "$GOOD_TOKEN"
    boot FAKE_CLONE_DENIED=3
    [ "$BOOT_RC" -eq 0 ] && order_is "gh login-with-token gh setup-git git clone git clone git clone git clone entrypoint " &&
        ok "retries the clone until access is granted" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    [ "$(hub '[.status[] | select(.phase == "awaiting_credentials")] | length')" -eq 1 ] &&
        hub '.status[] | select(.phase == "awaiting_credentials") | .detail' | grep -q 'cannot clone .*Repository not found' &&
        ok "reports the refused clone to the owner once" || no "status: $(hub -c '.status')"
    [ "$(hub '.status[-1].detail')" = "cloned cft-workspace" ] && ok "reports provisioning again once cloned" || no "status: $(hub -c '.status')"
    [ "$(hub '.prompts | length')" -eq 0 ] && ok "no device-code sign-in with a working token" || no "prompts: $(hub -c '.prompts')"
}

case_checkout_client() {
    setup checkout-client
    mkdir -p "$C/ws/cft-workspace/.git" "$C/ws/cft-workspace/.devcontainer/virtual-agent" "$C/ws/cft-workspace/scripts"
    # cft-workspace keeps scripts/agent-hub as a shim over the installed client, so a checkout can
    # pin an older one through AGENT_HUB_CLI.
    printf '#!/usr/bin/env bash\nexec "${AGENT_HUB_CLI:-agent-hub}" "$@"\n' >"$C/ws/cft-workspace/scripts/agent-hub"
    chmod +x "$C/ws/cft-workspace/scripts/agent-hub"
    printf '#!/bin/sh\necho entrypoint >>"$FAKE_DIR/order.log"\n' >"$C/ws/cft-workspace/.devcontainer/virtual-agent/entrypoint.sh"
    chmod +x "$C/ws/cft-workspace/.devcontainer/virtual-agent/entrypoint.sh"
    boot
    [ "$BOOT_RC" -eq 0 ] && order_is "gh device-login gh setup-git git fetch git merge entrypoint " &&
        ok "signs in, then fast-forwards the existing checkout" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    grep -q "signing in to GitHub with $C/ws/cft-workspace/scripts/agent-hub" "$C/out" && ok "prefers the checkout's client" || no "did not use the checkout's client"
}

# A volume may hold a checkout whose shim needs an install stage 0 has not done. Preferring it would relay no
# sign-in and back off forever, so the working installed client has to win.
case_broken_checkout_client() {
    setup broken-checkout-client
    mkdir -p "$C/ws/cft-workspace/.git" "$C/ws/cft-workspace/.devcontainer/virtual-agent" "$C/ws/cft-workspace/scripts"
    printf '#!/usr/bin/env bash\necho "agent-hub: cannot find module" >&2\nexit 127\n' >"$C/ws/cft-workspace/scripts/agent-hub"
    chmod +x "$C/ws/cft-workspace/scripts/agent-hub"
    printf '#!/bin/sh\necho entrypoint >>"$FAKE_DIR/order.log"\n' >"$C/ws/cft-workspace/.devcontainer/virtual-agent/entrypoint.sh"
    chmod +x "$C/ws/cft-workspace/.devcontainer/virtual-agent/entrypoint.sh"
    boot
    [ "$BOOT_RC" -eq 0 ] && order_is "gh device-login gh setup-git git fetch git merge entrypoint " &&
        ok "boots through with a shim that cannot run" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    grep -q "signing in to GitHub with $C/bin/agent-hub" "$C/out" && ok "falls through to the installed client" || no "did not fall through: $(grep 'signing in' "$C/out")"
}

case_no_client() {
    setup no-client
    rm "$C/bin/agent-hub"
    boot
    [ "$BOOT_RC" -ne 0 ] && [ "$(hub '.status[-1].phase')" = failed ] && ok "fails the agent when there is no client" || no "rc $BOOT_RC, status: $(hub -c '.status')"
    # node is still on PATH here, so the failure has to name the client rather than node.
    hub '.status[-1].detail' | grep -q 'no agent-hub client' && ok "says which client it looked for" || no "status: $(hub -c '.status')"
}

# A hub URL the owner typed with trailing slashes still has to address the hub: the TS client strips all of
# them, so this script must too, or every path becomes //api/… .
case_trailing_slash() {
    setup trailing-slash
    boot AGENT_HUB_URL="$HUB_URL//"
    [ "$BOOT_RC" -eq 0 ] && order_is "gh device-login gh setup-git git clone entrypoint " &&
        ok "boots through with a hub URL ending in slashes" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    [ "$(hub '.github')" = "$GOOD_TOKEN" ] && ok "reached the hub with the slashes stripped" || no "the token was not stored"
}

run_case() {
    case "$1" in
        no-token) case_no_token ;;
        refused-token) case_refused_token ;;
        stored-token-no-access) case_stored_token_no_access ;;
        checkout-client) case_checkout_client ;;
        broken-checkout-client) case_broken_checkout_client ;;
        no-client) case_no_client ;;
        trailing-slash) case_trailing_slash ;;
        *) printf 'unknown case %s (try --list)\n' "$1" >&2; exit 2 ;;
    esac
}

[ $# -gt 0 ] || { printf 'a case name is required: %s\n' "${CASES[*]}" >&2; exit 2; }
for name in "$@"; do run_case "$name"; done

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
