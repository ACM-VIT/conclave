"""Rewrites a backup archive the way an attacker with the age public key
could, for the backup tests. Reads the archive with age, applies the changes
in a JSON spec, rebuilds SHA256SUMS to match (unless told not to), and
encrypts the result to the recipients.

  python3 backup-tamper.py KEY RECIPIENTS IN OUT SPEC_JSON

Spec keys, all optional:
  append   {"sqlite-links": "line\\n", ...}   text added to payload files
  replace  {"MANIFEST": "text", ...}          payload files' new contents
  remove   ["./sqlite/live.db", ...]          outer members taken out
  outer    [member, ...]                      members added to the outer tar
  inner    [member, ...]                      members added to state-files.tar
  sums     {"keep": true}                     leave SHA256SUMS as it was
           {"extra": ["<hash>  /etc/passwd"]} lines added after rebuilding
A member is {"name", "type": "file"|"dir"|"symlink"|"hardlink"|"fifo",
"target", "data"}, or {"name", "from": PATH} for a file with PATH's bytes.
"""
import hashlib
import io
import json
import subprocess
import sys
import tarfile

key, recipients, source, out, spec = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], json.loads(sys.argv[5])


def member(entry):
    info = tarfile.TarInfo(entry["name"])
    kind = entry.get("type", "file")
    if "from" in entry:
        with open(entry["from"], "rb") as handle:
            data = handle.read()
    else:
        data = entry.get("data", "planted").encode()
    if kind == "file":
        info.size = len(data)
        return info, data
    info.type = {"dir": tarfile.DIRTYPE, "symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE}[kind]
    info.linkname = entry.get("target", "")
    return info, None


def read(blob, mode):
    entries = []
    with tarfile.open(fileobj=io.BytesIO(blob), mode=mode) as tar:
        for info in tar:
            data = tar.extractfile(info).read() if info.isreg() else None
            entries.append([info, data])
    return entries


def write(entries, mode):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode=mode, format=tarfile.PAX_FORMAT) as tar:
        for info, data in entries:
            if data is not None:
                info.size = len(data)
            tar.addfile(info, io.BytesIO(data) if data is not None else None)
    return buffer.getvalue()


def plain(name):
    return name[2:] if name.startswith("./") else name


plaintext = subprocess.run(["age", "--decrypt", "-i", key, source], check=True, capture_output=True).stdout
entries = read(plaintext, "r:gz")
by_name = {plain(info.name): item for item in entries for info in [item[0]]}
for name, text in spec.get("append", {}).items():
    if name in by_name:
        by_name[name][1] += text.encode()
    else:
        info = tarfile.TarInfo(f"./{name}")
        entries.append([info, text.encode()])
for name, text in spec.get("replace", {}).items():
    by_name[name][1] = text.encode()
if spec.get("inner"):
    item = by_name["state-files.tar"]
    inner = read(item[1], "r:")
    inner.extend(list(member(entry)) for entry in spec["inner"])
    item[1] = write(inner, "w")
removed = {plain(name) for name in spec.get("remove", [])}
entries = [item for item in entries if plain(item[0].name) not in removed]
entries.extend(list(member(entry)) for entry in spec.get("outer", []))
sums = spec.get("sums", {})
if not sums.get("keep"):
    lines = [f"{hashlib.sha256(data).hexdigest()}  ./{plain(info.name)}" for info, data in entries if data is not None and info.isreg() and plain(info.name) != "SHA256SUMS"]
    lines += sums.get("extra", [])
    text = "".join(f"{line}\n" for line in sorted(lines))
    for item in entries:
        if plain(item[0].name) == "SHA256SUMS":
            item[1] = text.encode()
subprocess.run(["age", "--encrypt", "-R", recipients, "-o", out], input=write(entries, "w:gz"), check=True)
