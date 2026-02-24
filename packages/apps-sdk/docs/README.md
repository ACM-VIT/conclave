# Apps SDK Docs

This docs tree explains how Conclave in-meeting apps work, how to build and integrate them, and how to debug runtime behavior when something goes wrong.

## Start Here

If you are new to the SDK, read in this order:

1. [Core Concepts](./reference/core-concepts.md)
2. [Runtime APIs and Hooks](./reference/runtime-apis.md)
3. [Add a New App Integration](./guides/add-a-new-app-integration.md)

## I Need To...

| Goal | Best doc |
| --- | --- |
| Understand the architecture and lifecycle | [Core Concepts](./reference/core-concepts.md) |
| See what each hook/helper returns | [Runtime APIs and Hooks](./reference/runtime-apis.md) |
| Learn the socket protocol and sync flow | [Socket Events and Sync](./reference/socket-events-and-sync.md) |
| Add a new app from scaffold to host wiring | [Add a New App Integration](./guides/add-a-new-app-integration.md) |
| Pick a schema/control pattern quickly | [App Cookbook](./guides/app-cookbook.md) |
| Validate permissions/lock behavior | [Permissions and Locking](./reference/permissions-and-locking.md) |
| Fix common integration bugs quickly | [Troubleshooting](./guides/troubleshooting.md) |
| Contribute with review-ready changes | [Contributing To Apps SDK](./guides/contributing-to-apps-sdk.md) |

## Guides

- [Add a New App Integration](./guides/add-a-new-app-integration.md): step-by-step wiring from scaffold to host integration.
- [App Cookbook](./guides/app-cookbook.md): recipe-style app patterns (polls, timer, notes, media).
- [Troubleshooting](./guides/troubleshooting.md): symptom-first fixes for common runtime/integration failures.
- [Contributing To Apps SDK](./guides/contributing-to-apps-sdk.md): contributor workflow, review checklist, and guardrails.
- [Dev Playground Walkthrough](./guides/dev-playground-walkthrough.md): learn by modifying the dev-only sample app.

## Reference

- [Core Concepts](./reference/core-concepts.md): architecture, lifecycle, and state model.
- [Runtime APIs and Hooks](./reference/runtime-apis.md): API-level behavior and usage notes.
- [Permissions and Locking](./reference/permissions-and-locking.md): admin/non-admin behavior and lock semantics.
- [Socket Events and Sync](./reference/socket-events-and-sync.md): event names, payload contracts, and sync/update flow.