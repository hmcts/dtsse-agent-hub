#!/usr/bin/env bash
# What a virtual agent's pod needs from the image in $1, asserted against a built one. One script so
# that the pull-request build and the post-push check cannot drift apart.
#
# The pod's command is ["virtual-agent-boot"] (src/orchestrator/manifests.ts), which the kubelet
# resolves with no shell against the image's PATH, while npm installs into nvm's version-specific bin
# directory. A base image that moves node's version, or a link derived wrongly, leaves every pod in
# CreateContainerError, and until this ran nothing said so before the image was published.
set -euo pipefail

image="${1:?an image ref is required}"

# The kubelet's PATH and nothing else: `env -i` drops the image's own environment, so a variable the
# build happens to set cannot stand in for one the pod will not have.
kubelet_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

status=0
output="$(docker run --rm --entrypoint env "$image" -i "PATH=$kubelet_path" virtual-agent-boot 2>&1)" || status=$?

# Both halves, not just the exit status: a missing interpreter or module also exits non-zero, and that
# is the failure being guarded against. The message proves the script was found, ran, and got as far
# as checking its own inputs.
if [[ "$status" -eq 0 || "$output" != *AGENT_HUB_URL* ]]; then
    {
        echo "virtual-agent-boot did not run under the kubelet's PATH in $image"
        echo "expected a non-zero exit mentioning AGENT_HUB_URL; got exit $status and:"
        echo "$output"
    } >&2
    exit 1
fi
echo "virtual-agent-boot resolves on the kubelet's PATH and stops at its own AGENT_HUB_URL check"

# Both links must point into nvm's version-specific tree: an `npm i -g` in a running pod reinstalls
# there, which is what lets virtual-agent-boot upgrade itself. agent-hub is run from a login shell
# that has sourced nvm, so it needs node on PATH and the check above cannot cover it.
docker run --rm --entrypoint bash "$image" -ec '
    for bin in agent-hub virtual-agent-boot; do
        target="$(readlink -f "/usr/local/bin/$bin")"
        [[ -x "$target" && "$target" == "$HOME"/.nvm/versions/node/* ]] || {
            echo "/usr/local/bin/$bin resolves to ${target:-nothing}, which is not an executable under nvm" >&2
            exit 1
        }
    done'
echo "both bins link into nvm's tree"
