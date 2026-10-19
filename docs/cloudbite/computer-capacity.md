# Personal computer capacity and remote GPU

Owner control APIs live under `/api/cloudbite/computer`, behind the existing computer/owner authentication. A refresh never provisions resources. A resize requires a UUID, an explicit price review and `acknowledgeCost:true`; unknown provider outcomes are reconciled against actual allocation instead of resubmitting blindly.

`GET performance` samples CPU time and RAM inside the computer's cgroup, caches for ten seconds, and reports missing measurements as unknown. Pricing is an estimate from Daytona's published CPU/RAM/storage rates, checked 2026-10-19. Disk remains unchanged.

## Current provider constraint

On 2026-10-19 an owned disposable 4-vCPU/8-GiB sandbox was created successfully, but the current primary API answered `Cannot POST .../resize` (404). A separate 8-vCPU create was refused because this organization allows at most 4 vCPU per sandbox; a separate 4-vCPU/8-GiB worker was successfully created and deleted. The user's persistent machine was never resized or restarted. Production therefore sets `CLOUDBITE_COMPUTER_HOT_RESIZE_ENABLED=0`. Do not advertise a successful increase while this is disabled. The implementation can be enabled after provider support and account capacity have been independently reverified. Increasing resources in code cannot bypass the provider's limits.

## GPU selection

The sandbox picker lists a bounded number of sandboxes in explicitly configured Daytona accounts. Choosing one only supplies its provider-reported region to GPU discovery; it never switches the personal desktop. Exact sandbox lookup under the chosen account key binds subsequent selection.

Nosana's unauthenticated reservation endpoints supply GPU models, country options, and current country/GPU-specific queued host counts. Country option counts are not treated as availability. Prices are host base prices, before network fees. Refresh timestamps and partial results are surfaced. A selected candidate is a preference, not a reservation or a billed rental.

Distance is a rough geographic ranking between a region reference point and a country centroid, not the real machine location or measured network latency. Unknown location is never converted to zero distance. There is no local PCIe attachment or shared VRAM: `cloudbite-compute` sends explicit remote GPU jobs and returns their results. Existing local programs do not automatically gain a CUDA device. Selected GPU/country requirements must reach deployment scheduling without falling back to another GPU/country. GPU job definitions are public; never put credentials in their image/command.

References: [Daytona scale](https://www.daytona.io/docs/en/scale/), [Daytona pricing](https://www.daytona.io/pricing), [Nosana GPU requirements](https://learn.nosana.com/api/reservations.html).
