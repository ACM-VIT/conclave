import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../docker/start.sh", import.meta.url));

const bashSupportsWaitN = (() => {
    const probe = spawnSync("bash", ["-c", "sleep 0 & wait -n"]);
    return probe.status === 0;
})();

const FAKE_X11VNC = `#!/bin/sh
{
  printf 'args'
  for arg in "$@"; do printf ' [%s]' "$arg"; done
  printf '\\n'
  printf 'env-password [%s]\\n' "\${VNC_PASSWORD-unset}"
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "-passwdfile" ]; then
      file="\${arg#rm:}"
      printf 'password-file [%s]\\n' "$(cat "$file" 2>/dev/null)"
    fi
    previous="$arg"
  done
} > "$X11VNC_LOG.partial"
mv "$X11VNC_LOG.partial" "$X11VNC_LOG"
exec sleep 30
`;

const LONG_RUNNING = "#!/bin/sh\nexec sleep 30\n";

const runEntrypoint = async (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "vnc-entrypoint-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries({ x11vnc: FAKE_X11VNC, Xvfb: LONG_RUNNING, websockify: LONG_RUNNING, chromium: LONG_RUNNING, xdpyinfo: "#!/bin/sh\nexit 0\n" })) {
        writeFileSync(join(bin, name), body);
        chmodSync(join(bin, name), 0o755);
    }
    const log = join(dir, "x11vnc.log");
    const script = join(dir, "start.sh");
    const source = readFileSync(entrypoint, "utf8");
    assert.ok(source.includes("/usr/bin/chromium \\\n"), "the entrypoint no longer starts /usr/bin/chromium");
    writeFileSync(script, source.replace("/usr/bin/chromium \\\n", "chromium \\\n"));
    const child = spawn("bash", [script], {
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, X11VNC_LOG: log, UBLOCK_ORIGIN_EXTENSION_DIR: dir, ...env },
        stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
        const deadline = Date.now() + 15_000;
        let code: number | null | undefined;
        void exited.then((value) => (code = value));
        while (!existsSync(log) && code === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        return { launched: existsSync(log) ? readFileSync(log, "utf8") : null, code, stderr };
    } finally {
        if (child.exitCode === null) {
            child.kill("SIGTERM");
            await exited;
        }
        rmSync(dir, { recursive: true, force: true });
    }
};

test("the session image's entrypoint starts x11vnc only with the session password, from a file, never from the environment", { skip: !bashSupportsWaitN && "bash here has no wait -n" }, async () => {
    const withPassword = await runEntrypoint({ VNC_PASSWORD: "Ab3dEf7h" });
    assert.ok(withPassword.launched, `x11vnc never started: ${withPassword.stderr}`);
    const lines = withPassword.launched.trim().split("\n");
    const args = lines[0];
    assert.match(args, /\[-passwdfile\] \[rm:[^\]]+\]/);
    assert.match(args, /\[-localhost\]/);
    assert.doesNotMatch(args, /\[-nopw\]|\[-passwd\]|Ab3dEf7h/);
    assert.equal(lines[1], "env-password [unset]");
    assert.equal(lines[2], "password-file [Ab3dEf7h]");

    for (const missing of [{}, { VNC_PASSWORD: "" }]) {
        const refused = await runEntrypoint(missing);
        assert.equal(refused.launched, null, "x11vnc started without a password");
        assert.equal(refused.code, 1);
        assert.match(refused.stderr, /VNC_PASSWORD is required/);
    }
});
