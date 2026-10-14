# Dependency patches

OpenNext Cloudflare 1.20.11 omits Next.js 16.4's `server/preview-props.json`
from its inlined manifest list. The Worker throws during Next.js server startup,
even when the production build succeeds. The versioned adapter patch includes
that generated manifest using the existing JSON inlining path. Unknown manifests
still throw. Run `pnpm test:cloudflare-manifests` and preview the production
bundle in Wrangler when upgrading either dependency. Remove the patch when the
adapter includes preview props upstream.

MediaPipe Tasks Vision 1.1.0 enables a metrics logger that sends performance and
usage data to Google. Its published API provides no logging opt-out. Conclave
keeps the latest package while disabling the optional logger initialization in
all three JavaScript bundles. Model loading and inference are unchanged.

The patch corresponds to `TaskRunner.enableLogging()` in upstream's
`mediapipe/tasks/web/core/task_runner.ts`. The logger is optional; inference and
cleanup already guard its calls. No task logger is constructed, so its reporting
timer, event queue, and network sender are never started. See the upstream
[privacy notice](https://github.com/google-ai-edge/mediapipe/blob/v1.1.0/mediapipe/tasks/web/vision/README.md#privacy-notice).

Review this patch when upgrading MediaPipe. Keep telemetry disabled unless a
separate product decision introduces disclosure and informed consent. Both
container builds copy the patch directory before their frozen dependency install.

Run `pnpm check:mediapipe-privacy` with Chrome installed, or set `CHROME_PATH`.
The check runs real WASM segmentation on a synthetic canvas for ESM, CommonJS,
and classic script bundles. It compares each patched bundle with an upstream
control and intercepts the reporting endpoint locally. The control must attempt
reporting; patched inference must produce masks without reporting. No control
metrics leave the browser.
