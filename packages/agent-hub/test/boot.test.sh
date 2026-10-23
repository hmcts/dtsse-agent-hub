#!/usr/bin/env bash
# bin/virtual-agent-boot against a mock hub, fake gh, git, npm and sleep, and the package's own client
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

CASES=(no-token refused-token stored-token-no-access checkout-client broken-checkout-client no-client trailing-slash
    client-upgrade client-upgrade-offline client-upgrade-no-npm client-upgrade-pinned)

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
    # The only npm any case may reach: the real one would install the published client globally from the
    # hmcts-lib feed. It records every invocation's arguments, and `ls` answers with npm's own
    # `<path>:<name>@<version>` so the script has a version to log. FAKE_NPM_FAIL is a feed it cannot reach.
    cat >"$C/bin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DIR/npm.args"
case "$1" in
    install)
        echo "npm install" >>"$FAKE_DIR/order.log"
        if [ -n "${FAKE_NPM_FAIL:-}" ]; then
            printf 'npm error code E404\nnpm error 404 Not Found - GET https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/@hmcts-cft%%2fagent-hub\n' >&2
            exit 1
        fi
        echo "changed 1 package in 2s" ;;
    ls) echo "/home/hmcts/.nvm/versions/node/v22.0.0/lib/node_modules/@hmcts-cft/agent-hub:@hmcts-cft/agent-hub@9.9.9" ;;
esac
EOF
    printf '#!/bin/sh\nexec "%s" 0.05\n' "$REAL_SLEEP" >"$C/bin/sleep"
    # node is on PATH through the case's own bin directory, so dropping the client (no-client) does
    # not also drop node, and nothing the machine happens to have installed globally stands in for it.
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$REAL_NODE" >"$C/bin/node"
    chmod +x "$C/bin/gh" "$C/bin/git" "$C/bin/npm" "$C/bin/sleep" "$C/bin/node"
    # npm links a package's bin into the global bin directory, so the client runs from a symlink.
    ln -s "$CLIENT" "$C/bin/agent-hub"
    # The PATH the script boots with. client-upgrade-no-npm checks it for an npm of its own before booting.
    BOOT_PATH="$C/bin:/usr/bin:/bin"
}

# seed_github TOKEN: the GitHub token the owner stored on the hub before the pod booted.
seed_github() {
    curl -sS -o /dev/null -X PUT -H "Authorization: Bearer $LAUNCH" -H 'Content-Type: application/json' \
        --data-binary "{\"value\":\"$1\"}" "$HUB_URL/api/virtual/$VID/credentials/github"
}

# boot [VAR=value…]: runs the boot script to its end (the fake entrypoint exits), at most 30s.
boot() {
    env -i PATH="$BOOT_PATH" HOME="$C/home" NVM_DIR=/nonexistent FAKE_DIR="$C" \
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
    order_is "gh device-login gh setup-git git clone npm install entrypoint " && ok "signs in to GitHub before the clone" || no "order: $(tr '\n' ' ' <"$C/order.log")"
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
    [ "$BOOT_RC" -eq 0 ] && order_is "gh device-login gh setup-git git clone npm install entrypoint " &&
        ok "a refused stored token falls back to the device-code sign-in" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    hub '.status[1].detail' | grep -q '^github: the stored GitHub token was refused' && ok "says the stored token was refused" || no "status: $(hub -c '.status')"
    [ "$(hub '.github')" = "$GOOD_TOKEN" ] && ok "replaces the token on the hub" || no "the token was not replaced"
}

case_stored_token_no_access() {
    setup stored-token-no-access
    seed_github "$GOOD_TOKEN"
    boot FAKE_CLONE_DENIED=3
    [ "$BOOT_RC" -eq 0 ] && order_is "gh login-with-token gh setup-git git clone git clone git clone git clone npm install entrypoint " &&
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
    [ "$BOOT_RC" -eq 0 ] && order_is "gh device-login gh setup-git git fetch git merge npm install entrypoint " &&
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
    [ "$BOOT_RC" -eq 0 ] && order_is "gh device-login gh setup-git git fetch git merge npm install entrypoint " &&
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
    [ "$BOOT_RC" -eq 0 ] && order_is "gh device-login gh setup-git git clone npm install entrypoint " &&
        ok "boots through with a hub URL ending in slashes" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    [ "$(hub '.github')" = "$GOOD_TOKEN" ] && ok "reached the hub with the slashes stripped" || no "the token was not stored"
}

# A pod would otherwise be stuck with the client its image baked in, so stage 0's last act is to install the
# published one. The cases below boot with a working stored token, which is the shortest route to the handover.
case_client_upgrade() {
    setup client-upgrade
    seed_github "$GOOD_TOKEN"
    boot
    [ "$BOOT_RC" -eq 0 ] && order_is "gh login-with-token gh setup-git git clone npm install entrypoint " &&
        ok "upgrades the client last, then hands over" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    grep -qE '(^| )-g( |$)' "$C/npm.args" && grep -qF -- '@hmcts-cft/agent-hub@latest' "$C/npm.args" &&
        ok "installs the published client globally and unpinned" || no "npm args: $(cat "$C/npm.args" 2>/dev/null)"
    grep -qF -- '--@hmcts-cft:registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/' "$C/npm.args" &&
        ok "points the @hmcts-cft scope at the hmcts-lib feed" || no "npm args: $(cat "$C/npm.args" 2>/dev/null)"
    # The feed holds @hmcts-cft packages alone, so a bare --registry 404s on the first public package.
    grep -qE '(^| )--registry=' "$C/npm.args" && no "sent every package to the hmcts-lib feed" ||
        ok "leaves every other package on the default registry"
    grep -q 'agent-hub client is @hmcts-cft/agent-hub@9.9.9' "$C/out" &&
        ok "logs the version it ended up with" || no "version not logged: $(grep 'agent-hub client' "$C/out")"
}

case_client_upgrade_offline() {
    setup client-upgrade-offline
    seed_github "$GOOD_TOKEN"
    boot FAKE_NPM_FAIL=1
    [ "$BOOT_RC" -eq 0 ] && order_is "gh login-with-token gh setup-git git clone npm install entrypoint " &&
        ok "hands over anyway when the feed cannot be reached" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    grep -q "keeping the image's" "$C/out" && grep -q 'E404' "$C/out" &&
        ok "says why the client was not upgraded" || no "no reason logged: $(grep 'client' "$C/out")"
    [ "$(hub '.status[-1].phase')" != failed ] && ok "does not fail the agent over the feed" || no "status: $(hub -c '.status')"
}

case_client_upgrade_no_npm() {
    setup client-upgrade-no-npm
    rm "$C/bin/npm"
    # Only the fake npm may ever run, so a machine carrying one in /usr/bin or /bin fails the case instead of
    # letting the install reach the real feed.
    if (PATH="$BOOT_PATH"; command -v npm >/dev/null 2>&1); then
        no "an npm outside the case's bin directory is on $BOOT_PATH"
        return 0
    fi
    seed_github "$GOOD_TOKEN"
    boot
    [ "$BOOT_RC" -eq 0 ] && order_is "gh login-with-token gh setup-git git clone entrypoint " &&
        ok "hands over with no npm to upgrade with" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    grep -q 'client upgrade skipped: npm is not on PATH' "$C/out" && ok "says npm was missing" || no "no reason logged: $(grep 'client' "$C/out")"
}

case_client_upgrade_pinned() {
    setup client-upgrade-pinned
    seed_github "$GOOD_TOKEN"
    boot VIRTUAL_AGENT_SKIP_CLIENT_UPGRADE=true
    [ "$BOOT_RC" -eq 0 ] && order_is "gh login-with-token gh setup-git git clone entrypoint " &&
        ok "hands over without upgrading when the pod is pinned" || no "rc $BOOT_RC, order: $(tr '\n' ' ' <"$C/order.log")"
    [ ! -f "$C/npm.args" ] && ok "runs no npm at all" || no "npm args: $(cat "$C/npm.args" 2>/dev/null)"
    grep -q 'client upgrade skipped: VIRTUAL_AGENT_SKIP_CLIENT_UPGRADE is set' "$C/out" &&
        ok "says the pod is pinned" || no "no reason logged: $(grep 'client' "$C/out")"
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
        client-upgrade) case_client_upgrade ;;
        client-upgrade-offline) case_client_upgrade_offline ;;
        client-upgrade-no-npm) case_client_upgrade_no_npm ;;
        client-upgrade-pinned) case_client_upgrade_pinned ;;
        *) printf 'unknown case %s (try --list)\n' "$1" >&2; exit 2 ;;
    esac
}

[ $# -gt 0 ] || { printf 'a case name is required: %s\n' "${CASES[*]}" >&2; exit 2; }
for name in "$@"; do run_case "$name"; done

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
