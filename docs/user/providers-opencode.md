# OpenCode

Install and authenticate OpenCode on the machine running your environment, then
enable it in **Settings > Providers**. See [provider setup](./install.md#providers).
T3 Code requires OpenCode 1.14.19 or newer, including when you connect an existing
OpenCode server.

## Local or external server

Leave **Server URL** empty to let T3 Code start OpenCode locally. A password in
provider settings applies to both that server and T3 Code's connection. With no
password setting, the local server uses `OPENCODE_SERVER_PASSWORD` from its
environment.

To use an existing OpenCode server, set **Server URL** and its password in provider
settings. T3 Code uses only that configured password for an external server; it
does not forward a local `OPENCODE_SERVER_PASSWORD`. If connection or version checks
fail, check the URL, credentials, and OpenCode version, then refresh provider status.

After a lost connection, send another prompt to reconnect to the same OpenCode
session.

## Approvals

OpenCode follows the shared [permission modes](./permission-modes.md). **Auto** has
the same rules as **Supervised** because OpenCode has no AI approval reviewer.
Environment files such as `.env` and `.env.local` need approval in restricted
modes even though normal file reads do not; `.env.example` is allowed.

**Allow for workspace** applies to matching requests in other OpenCode sessions
using the same workspace. It is broader than the current thread, especially on a
shared external server. Use **Allow once** for a single request. Denying an action
does not stop the whole turn.

## Refresh models, commands, and skills

After changing an OpenCode login or configuration, use **Refresh provider status**
in **Settings > Providers** for that environment. On mobile, use **Refresh models**
in the thread settings. Reconnecting also refreshes the catalog; periodic provider
health checks do not.

Credential changes are read on refresh. Native OpenCode configuration can remain
cached while the local helper is running. Let it sit for 30 seconds without model
refreshes or text-generation work, then refresh again to reload the files. Repeated
refreshes keep the helper alive. An external server may need its own reload or
restart before T3 Code can see configuration changes.

Existing threads keep their selected model and options even when it disappears
from the catalog. If OpenCode rejects that model, select an available one and retry.

## Usage limits

Refresh **Usage > Limits** to read OpenCode Go subscription windows and connected
OpenRouter key spending caps. Go reports five-hour, weekly and monthly usage with
reset times when OpenCode runs locally in the environment. Go limits are
unavailable for external OpenCode servers because T3 cannot read their credentials.

OpenRouter caps can be read through local or external OpenCode servers when the
connected provider exposes its resolved key. OpenRouter reports the USD amount
left under a configured key cap. That cap is separate from the account balance
and free-model requests. Custom OpenRouter API endpoints and connections that do
not expose their resolved key cannot be probed.

OpenRouter does not expose remaining free requests through its key API. A key
without a spending cap therefore has no percentage bar. OpenCode Zen also does not
expose remaining credits or free-model requests through a supported usage API.
These limits appear as unavailable, not as zero usage. When another connected
provider supplies quota windows, the bars name only that provider's allowance.

Keys without a reported account identity stay separate across environments. A
pooled key-cap percentage averages the reported percentages; it is not a combined
USD balance. Open an account's details to see its key cap.
