"""Build and validate the Foundry release using Python's standard library."""
import argparse
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "module.json", "README.md", "SOURCES.md", "open-wounds-macro.json",
    "scripts/main.mjs", "scripts/rules.mjs", "scripts/management.mjs",
    "styles/wounds.css",
)
REPOSITORY = "https://github.com/Heyone77/grievous-wounds"


def build(tag=None):
    manifest_bytes = (ROOT / "module.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("Use a stable three-part numeric version")
    expected_tag = f"v{version}"
    if tag is not None and tag != expected_tag:
        raise ValueError(f"Tag {tag!r} does not match {expected_tag}")
    expected = {
        "id": "grievous-wounds",
        "url": REPOSITORY,
        "manifest": f"{REPOSITORY}/releases/latest/download/module.json",
        "download": f"{REPOSITORY}/releases/download/{expected_tag}/grievous-wounds.zip",
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise ValueError(f"Invalid module.json.{key}: expected {value}")
    if package["version"] != version:
        raise ValueError("package.json version does not match module.json")
    for filename in manifest.get("esmodules", []) + manifest.get("styles", []):
        if filename not in FILES:
            raise ValueError(f"Runtime file missing from release allowlist: {filename}")
    contents = {name: (ROOT / name).read_bytes() for name in FILES}
    output = ROOT / "output" / "release"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "grievous-wounds.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, data in contents.items():
            info = zipfile.ZipInfo(f"grievous-wounds/{name}", date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, data)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None:
            raise ValueError("Archive integrity check failed")
        if set(bundle.namelist()) != {f"grievous-wounds/{name}" for name in FILES}:
            raise ValueError("Unexpected archive contents")
        for name, data in contents.items():
            if bundle.read(f"grievous-wounds/{name}") != data:
                raise ValueError(f"Archive differs from source: {name}")
    (output / "module.json").write_bytes(manifest_bytes)
    print(f"Validated {expected_tag}: {len(FILES)} files, {archive.stat().st_size} bytes")
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Require this release tag to match the manifest")
    build(parser.parse_args().tag)
