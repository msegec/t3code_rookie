# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, SSH, and T3 Connect change how the client reaches that server; they do
not introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md) and the
[T3 Connect trust boundary](./t3-connect.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

## Collaborative browser context

Providers receive one shared browser instruction block from
[`T3BrowserInstructions.ts`](../../apps/server/src/provider/T3BrowserInstructions.ts). Codex and
Claude use their instruction channels; OpenCode uses request system context. Cursor and Grok receive
the block with the first successfully submitted prompt of each new or resumed ACP runtime because
ACP has no system instruction field. The existing prompt semaphore owns delivery and retry state.
Tool schemas own operation details. Current environment and browser-host facts
appear only in `preview_status`, not in injected prompts or every navigation result.

The automation broker keeps each provider session on its selected desktop host. That host resolves
workspace files against its own prepared environment connection using the existing asset capability
flow. The server owns thread-to-worktree resolution and path validation. Navigation target support
is negotiated separately from operation support, so an older host can reject a workspace-file
target without attempting to interpret it as a port.

Dynamic HTTP previews use the desktop's existing local T3 listener as a browser origin. A scoped
`t3-preview-*.localhost` host routes through the environment's existing HTTP endpoint to its
loopback application port. The same transport streams HTTP and WebSocket upgrades; it adds no
listener, process, dependency, HTML rewriting or application port exposure. Relay and SSH
connections reuse their prepared endpoint. The initial transport requires Node on both T3 servers
and HTTP at the application, although the environment endpoint may use HTTPS.

Authenticated RPCs issue and register routes scoped to an environment, thread and application port.
The environment validates the execution thread; the desktop validates its local backend connection.
Routes stay in bounded memory, expire after 15 minutes idle, retain active transfers and close on
revocation. Existing session-removal events revoke owned routes without polling. The client releases
unused routes on tab closure, failed loads and connection changes. Physical preview URLs remain
desktop-local; a different desktop must reopen the logical application target.
