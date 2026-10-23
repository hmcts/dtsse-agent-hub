# The image a virtual agent's pod runs: the cft-workspace devcontainer image plus the agent-hub
# client, which is the whole of what stage 0 needs before it can clone the workspace. It lives here
# rather than in cft-workspace because the client it installs is published from this repository, and
# a developer image should not carry pod-only machinery.
#
# Nothing in the base is changed: not the user, not HOME, not the command. The pod needs uid/gid 1000
# with runAsNonRoot, /home/hmcts, node via nvm, npm, tmux, git, gh and curl, and all of that is the
# base's.
#
# The tag is a build arg so a build can be pinned to a known devcontainer image; the publish workflow
# leaves it at the default and takes whatever :latest is at the time.
ARG DEVCONTAINER_TAG=latest
FROM hmctsprod.azurecr.io/cft-workspace/devcontainer:${DEVCONTAINER_TAG}

# The feed registry is set for the @hmcts-cft scope alone: hmcts-lib holds nothing else, and a bare
# --registry would send every other package there. Its reads are anonymous, so this needs no
# credential.
#
# `@latest` is what the image is for, so it must not be pinned: the layer's job is to carry the newest
# published client. Nothing caches this build, for the same reason — see the publish workflow.
#
# npm's global bin directory is $NVM_DIR/versions/node/<version>/bin, which is on PATH only for a
# shell that has sourced nvm.sh. The pod's command is ["virtual-agent-boot"] (src/orchestrator/
# manifests.ts), resolved by the kubelet with no shell against the image's PATH, so both bins are
# linked into /usr/local/bin. The links are made from `command -v` rather than written literally so
# they point at node's version-specific path; a later `npm i -g` reinstalls to the same place and the
# links keep working, which is what lets virtual-agent-boot upgrade itself in a running pod.
#
# The install itself needs no sudo: the build runs as hmcts and npm's global prefix is under that
# user's own $HOME/.nvm. /usr/local/bin is root-owned, so the links do, through the base's
# NOPASSWD sudoers entry for hmcts.
#
# The closing `npm ls` changes nothing in the image; it prints the version that `@latest` turned out
# to be into the build log, which is the only record of it — the tags carry a commit, and the
# client's version is not committed back by release.yml.
RUN bash -c 'export NVM_DIR="$HOME/.nvm"; \
    . "$NVM_DIR/nvm.sh"; \
    nvm use default; \
    npm install -g \
        --@hmcts-cft:registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/ \
        @hmcts-cft/agent-hub@latest \
    && bin="$(command -v agent-hub)" && sudo ln -sf "$bin" /usr/local/bin/agent-hub \
    && boot="$(command -v virtual-agent-boot)" && sudo ln -sf "$boot" /usr/local/bin/virtual-agent-boot \
    && npm ls -g --depth=0 @hmcts-cft/agent-hub'
