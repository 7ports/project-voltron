# Voltron OPA AuthZ policy (OPTIONAL, defense-in-depth)
#
# WHY THIS EXISTS
# ----------------
# wollomatic/socket-proxy enforces METHOD + path AND bind-mount SOURCES
# (-allowbindmountfrom). It does NOT inspect HostConfig.Privileged or
# HostConfig.PidMode. The Voltron allowlist spec requires rejecting
# Privileged=true and PidMode=host inside the POST /containers/create body.
# That gap can ONLY be closed by a Docker authorization (AuthZ) plugin that
# parses the request body, e.g. open-policy-agent/opa-docker-authz loaded on
# the HOST daemon with --authorization-plugin.
#
# This is a SEPARATE, daemon-side control, NOT part of the socket-proxy
# sidecar. Deploy it on the host that runs the real dockerd if you need the
# Privileged/PidMode guarantees. It is OPTIONAL: if you accept the residual
# risk documented in README.md (an agent that bypasses the proxy boundary
# could still request Privileged), you may run the socket-proxy layer alone.
#
# KNOWN BYPASS (be honest): CVE-2026-34040. Every Docker AuthZ plugin that
# inspects the request body (OPA, Casbin, Prisma/Twistlock, custom) can be
# defeated by padding the create body past ~1MB, after which the daemon drops
# the body before the plugin sees it and the request is allowed. Also see
# opa-docker-authz issue #34: Binds/Mounts normalization tricks can evade
# naive prefix checks. Treat this policy as defense-in-depth, NOT a guarantee.
# Mitigate by keeping the daemon patched and pairing with the proxy allowlist.
#
# Loaded as: opa-docker-authz plugin, package name must be docker.authz.

package docker.authz

import rego.v1

default allow := false

# Allow by default UNLESS a deny rule below fires. The proxy is the primary
# allowlist; this policy only vetoes the body fields the proxy cannot see.
allow if {
	not denied
}

denied if {
	is_container_create
	input.Body.HostConfig.Privileged == true
}

denied if {
	is_container_create
	input.Body.HostConfig.PidMode == "host"
}

# Defense-in-depth duplicate of the proxy's -allowbindmountfrom check. Reject
# any bind whose host source is '/' or is outside the allowed workspace prefix.
denied if {
	is_container_create
	some b in input.Body.HostConfig.Binds
	not bind_source_allowed(b)
}

is_container_create if {
	input.Method == "POST"
	endswith(input.Path, "/containers/create")
}

# A bind is "host-src:container-dst[:opts]". Allow only when the host source is
# the workspace path or a subdirectory of it. Replace the prefix to match
# -allowbindmountfrom in the proxy config.
bind_source_allowed(bind) if {
	parts := split(bind, ":")
	src := parts[0]
	startswith(src, "/srv/voltron/workspace")
	src != "/"
}
