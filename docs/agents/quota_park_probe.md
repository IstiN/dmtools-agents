# quota park probe

Bounded self-lift for the gh-1087 provider-quota park: runs locally on every SM tick against tickets carrying the park label (default `provider_quota`) and fires one cheap provider ping only when the recorded probe count hits the `jobParams.quotaProbeEveryNTicks` cadence (default 3 ticks).

Probe success means the quota window has reset or the provider was reconfigured — the handler removes the park label, clears the development/rework dispatch trigger labels, moves the ticket back to Ready For Development and posts an un-park comment, so the normal dispatch lanes resume on the next tick. Probe failure keeps the park and posts a one-line `quota-probe: <n>` marker comment that doubles as the durable counter for the next tick's cadence decision.

## Parameters

- `jobParams.quotaParkLabel` — park label name to watch and remove (default `provider_quota`). When overridden, the SM rule's JQL (`labels = provider_quota`) must be overridden to match.
- `jobParams.quotaProbeEveryNTicks` — probe cadence in SM ticks (default 3). The first tick after the park always probes (a misclassification self-corrects immediately).
- `jobParams.quotaProbeCommand` — the cheap provider ping shell command (default: a 1-token chat completion against the fa provider config `FA_PROVIDER_BASE_URL` / `FA_PROVIDER_API_KEY` / `FA_PROVIDER_MODEL`; curl `--fail` keeps the park on any HTTP error). Override for non-fa provider shapes.

A human un-parks immediately by removing the park label from the ticket — the probe rule stops matching and no further probes fire.
