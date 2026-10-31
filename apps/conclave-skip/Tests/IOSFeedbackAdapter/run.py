#!/usr/bin/env python3
"""Compile six real iOS sources and run a silent adapter probe on an already booted simulator.
No app install/launch, UI automation, standard preference writes, stubs or package resolution.
Use --baseline-api only with the preserved old adapter API. Every run needs a fresh output path.
"""
import argparse, datetime, hashlib, json, os, platform, shutil, subprocess, sys
from pathlib import Path

SOURCES = [
    'Sources/Conclave/DesignSystem/Feedback.swift',
    'Sources/Conclave/DesignSystem/FeedbackDelivery.swift',
    'Sources/Conclave/Features/Meeting/Panels/MeetingPanel.swift',
    'Sources/Conclave/Features/Meeting/Panels/PanelCoordinator.swift',
    'Sources/Conclave/App/Hosting/NativeHostingPresenter.swift',
    'Sources/Conclave/DesignSystem/iOS/ConclaveFeedback+iOS.swift',
]
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--udid', required=True)
    parser.add_argument('--baseline-api', action='store_true')
    args = parser.parse_args()
    root = args.repo.resolve(); out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    driver = Path(__file__).resolve().with_name('Probe.swift')
    inputs = [root / 'apps/conclave-skip' / p for p in SOURCES] + [driver, Path(__file__).resolve()]
    def identities():
        return {str(p): sha(p) for p in inputs}
    def save(name, value):
        (out / name).write_text(json.dumps(value, indent=2) + '\n')
    def command(name, argv, *, allow_failure=False):
        free = shutil.disk_usage(out).free
        if free < 1024**3:
            raise RuntimeError(f'Less than 1 GiB free before {name}: {free}')
        before = identities(); start = now()
        with (out / (name + '.log')).open('x') as log:
            result = subprocess.run(argv, cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=300)
        after = identities()
        receipt = dict(name=name, argv=argv, cwd=str(root), started_at=start, ended_at=now(),
                       exit_code=result.returncode, free_bytes_before=free,
                       environment={k: os.environ.get(k) for k in ['DEVELOPER_DIR', 'SDKROOT', 'PATH']},
                       input_hashes_before=before, input_hashes_after=after, inputs_unchanged=before == after)
        save(name + '.json', receipt)
        with (out / 'commands.jsonl').open('a') as f:
            f.write(json.dumps(receipt) + '\n')
        print(json.dumps(dict(command=name, exit_code=result.returncode)), flush=True)
        if before != after:
            raise RuntimeError('Inputs changed during ' + name)
        if result.returncode and not allow_failure:
            raise RuntimeError(f'Setup command failed: {name}; see preserved log')
        return result.returncode, (out / (name + '.log')).read_text()
    try:
        save('inputs.json', identities())
        for index, p in enumerate(inputs):
            destination = out / 'inputs' / f'{index:02d}-{p.name}'
            destination.parent.mkdir(exist_ok=True)
            shutil.copy2(p, destination)
        _, compiler = command('compiler-path', ['xcrun', '--sdk', 'iphonesimulator', '--find', 'swiftc'])
        _, sdk = command('sdk-path', ['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'])
        _, sdk_version = command('sdk-version', ['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-version'])
        command('compiler-version', [compiler.strip(), '--version'])
        _, devices = command('simulator-inventory', ['xcrun', 'simctl', 'list', 'devices', '--json'])
        matches = [(runtime, d) for runtime, group in json.loads(devices)['devices'].items()
                   for d in group if d['udid'] == args.udid]
        if len(matches) != 1 or matches[0][1]['state'] != 'Booted':
            raise RuntimeError('Pinned simulator must already be booted; runner never boots devices')
        if platform.machine() != 'arm64':
            raise RuntimeError('This probe invocation requires the recorded arm64 host')
        save('platform.json', dict(sdk=sdk.strip(), sdk_version=sdk_version.strip(), target='arm64-apple-ios17.0-simulator',
                                  compiler=compiler.strip(), runtime=matches[0][0], device=matches[0][1], host_arch=platform.machine()))
        executable = out / 'ConclaveFeedbackProbe'
        argv = [compiler.strip(), '-sdk', sdk.strip(), '-target', 'arm64-apple-ios17.0-simulator',
                '-swift-version', '5', '-parse-as-library', '-module-name', 'ConclaveFeedbackProbe',
                '-module-cache-path', str(out / 'module-cache')]
        if args.baseline_api:
            argv += ['-D', 'BASELINE_ADAPTER']
        argv += [str(p) for p in inputs[:-1]] + ['-framework', 'Foundation', '-framework', 'SwiftUI',
                '-framework', 'UIKit', '-o', str(executable)]
        command('compile', argv)
        save('executable.json', dict(path=str(executable), sha256=sha(executable), bytes=executable.stat().st_size))
        command('executable-format', ['/usr/bin/file', str(executable)])
        code, output = command('probe', ['xcrun', 'simctl', 'spawn', args.udid, str(executable)], allow_failure=True)
        events = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        summaries = [e for e in events if e.get('type') == 'summary']
        if len(summaries) != 1:
            raise RuntimeError('Probe did not complete assertions; execution/setup failure, not red')
        summary = summaries[0]
        if code not in [0, 1] or (code == 0) != (summary['failures'] == 0):
            raise RuntimeError('Probe exit does not match assertion summary')
        save('result.json', dict(classification='behavioral-red' if code else 'green', exit_code=code,
                                summary=summary, failed_assertions=[e for e in events if e.get('type') == 'assertion' and not e['pass']],
                                executable_sha256=sha(executable), inputs=identities(),
                                boundary='real adapter direct callbacks; modifier compiled but not mounted; no app-runtime claim'))
        return code
    except Exception as error:
        save('setup-failure.json', dict(at=now(), classification='setup-failure-not-red', error=str(error)))
        raise
if __name__ == '__main__':
    sys.exit(main())
