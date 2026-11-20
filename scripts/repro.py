"""Shared logic behind scripts/check-toolchain.sh, scripts/repro-build.sh, scripts/deployment-build-record.sh and
scripts/verify-deployment.sh. Run it with `python3 -I scripts/repro.py <command> ...`.

Hashes that leave this file are deterministic: JSON is written with sorted keys and no timestamps, and nothing
platform-specific (paths, binary hashes) goes into the manifest.
"""

import argparse
import base64
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tomllib

# Built by the workspace for experiments, deployed nowhere.
EXCLUDED_CIRCUITS = {"math_probe"}

PROTOCOL_CONTRACTS = [
    "src/privacy/PairInputs.sol:PairInputs",
    "src/privacy/PrivatePairs.sol:PrivatePairs",
    "src/privacy/PrivateSpot.sol:PrivateSpot",
    "src/privacy/PrivateMarkets.sol:PrivateMarkets",
]

# Getter on a protocol contract -> circuit whose verifier it must return. The record key (pool, spot, markets) is the
# address field of the deployment record that holds the contract.
WIRING = {
    "pool": {
        "appendVerifier": "append",
        "spendVerifier": "spend",
        "lockVerifier": "lock",
        "openVerifier": "open_pair",
        "liquidateVerifier": "liquidate",
        "releaseVerifier": "release",
        "fundingEpochVerifier": "funding_epoch",
        "closeVerifier": "close_pair",
        "exitRequestVerifier": "exit_request",
        "updateVerifier": "pair_update",
    },
    "spot": {
        "swapVerifier": "swap",
        "lpAddVerifier": "lp_add",
        "lpSetVerifier": "lp_set",
        "lpRemoveVerifier": "lp_remove",
        "sweepProtocolVerifier": "sweep_protocol",
    },
    "markets": {
        "bondReleaseVerifier": "bond_release",
        "redeemVerifier": "redeem_claim",
        "sweepVerifier": "insurance_sweep",
        "popVerifier": "key_pop",
    },
}
RECORD_CONTRACTS = {"pool": "PrivatePairs", "spot": "PrivateSpot", "markets": "PrivateMarkets"}

# A library's runtime holds its own address for call protection: PUSH20 at byte 1 under the legacy pipeline, the
# library_deploy_address immutable under via-IR. Deployment fills it in.
LIBRARY_PREFIX = "73" + "00" * 20
VIA_IR_LIBRARY_ADDRESS = "library_deploy_address"


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, indent=2, sort_keys=True) + "\n")


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path, limit=None):
    h = hashlib.sha256()
    remaining = limit
    with open(path, "rb") as f:
        while remaining is None or remaining > 0:
            chunk = f.read(1 << 20 if remaining is None else min(1 << 20, remaining))
            if not chunk:
                break
            h.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
    if remaining:
        fail(f"{path} is shorter than {limit} bytes")
    return h.hexdigest()


def tree_sha256(root):
    lines = []
    for d, _, files in os.walk(root):
        for name in files:
            p = os.path.join(d, name)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            lines.append((rel, f"{sha256_file(p)}  {rel}\n"))
    return sha256_bytes("".join(line for _, line in sorted(lines)).encode())


def run(cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout


def tool_output(path, *args):
    """Output of a version query, or "" when the tool is missing or can't run on this machine."""
    if not path:
        return ""
    try:
        return run([path, *args])
    except (OSError, subprocess.CalledProcessError) as e:
        hint = ""
        if isinstance(e, subprocess.CalledProcessError) and e.returncode == -4:
            hint = " (SIGILL: this CPU or emulator lacks an instruction the binary uses)"
        print(f"error  {path} {' '.join(args)}: {e}{hint}", file=sys.stderr)
        return ""


def keccak(hex_code):
    return run(["cast", "keccak", "0x" + hex_code]).strip()


def platform_key():
    arch = {"x86_64": "amd64", "amd64": "amd64", "arm64": "arm64", "aarch64": "arm64"}
    machine = platform.machine().lower()
    return f"{platform.system().lower()}-{arch.get(machine, machine)}"


def camel(circuit):
    return "".join(p[:1].upper() + p[1:] for p in circuit.split("_"))


def snake(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def word(value):
    return f"0x{value:064x}"


# ---------------------------------------------------------------------------------------------------------- toolchain


def cmd_solc_path(a):
    if os.environ.get("REPRO_SOLC"):
        print(os.environ["REPRO_SOLC"])
        return
    version = load(a.lock)["solc"]["version"]
    # svm-rs keeps ~/.svm when it exists, otherwise the platform data dir.
    home = os.path.expanduser("~")
    svm = os.path.join(home, ".svm")
    if not os.path.isdir(svm):
        if platform.system() == "Darwin":
            svm = os.path.join(home, "Library/Application Support/svm")
        else:
            svm = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local/share"), "svm")
    print(os.path.join(svm, version, f"solc-{version}"))


def cmd_toolchain(a):
    lock = load(a.lock)
    plat = platform_key()
    drift = []

    def check(item, expected, got):
        if expected == got:
            print(f"ok     {item}: {got}")
        else:
            print(f"DRIFT  {item}: expected {expected}, got {got}")
            drift.append(item)

    def binary(tool, path):
        pin = lock[tool]["platforms"].get(plat)
        if path is None:
            check(f"{tool} binary", "on PATH", "missing")
        elif pin is None:
            check(f"{tool} binary", f"a pinned platform ({', '.join(sorted(lock[tool]['platforms']))})", plat)
        else:
            check(f"{tool} binary sha256", pin["binarySha256"], sha256_file(path))

    print(f"platform {plat}")
    observed = {}

    nargo = shutil.which("nargo")
    out = tool_output(nargo, "--version")
    noirc = re.search(r"noirc version = (\S+)", out)
    dirty = re.search(r"is dirty: (\w+)", out)
    observed["noirc"] = noirc.group(1) if noirc else "missing"
    check("noirc", f"{lock['nargo']['version']}+{lock['nargo']['noircCommit']}", observed["noirc"])
    check("noirc dirty flag", "false", dirty.group(1) if dirty else "unknown")
    binary("nargo", nargo)

    bb = shutil.which("bb")
    observed["bb"] = tool_output(bb, "--version").strip() or "missing"
    check("bb", lock["bb"]["version"], observed["bb"])
    binary("bb", bb)

    forge = shutil.which("forge")
    out = tool_output(forge, "--version")
    version = re.search(r"Version: (\S+)", out)
    commit = re.search(r"Commit SHA: ([0-9a-f]+)", out)
    observed["forge"] = f"{version.group(1) if version else 'missing'}+{commit.group(1) if commit else 'missing'}"
    check("forge", f"{lock['forge']['version']}+{lock['forge']['commit']}", observed["forge"])
    binary("forge", forge)

    if a.solc and os.path.isfile(a.solc):
        solc_version = re.search(r"Version: (\d+\.\d+\.\d+\+commit\.[0-9a-f]+)", tool_output(a.solc, "--version"))
        observed["solc"] = solc_version.group(1) if solc_version else "unknown"
        pin = lock["solc"]["platforms"].get(plat)
        check("solc binary sha256", pin["sha256"] if pin else f"a pinned platform, not {plat}", sha256_file(a.solc))
    else:
        observed["solc"] = "missing"
    check("solc", lock["solc"]["longVersion"], observed["solc"])

    crs = lock["crs"]
    g1 = os.path.join(a.crs_dir, "bn254_g1_compressed.dat")
    g2 = os.path.join(a.crs_dir, "bn254_g2.dat")
    grumpkin = os.path.join(a.crs_dir, "grumpkin_g1_v2.flat.dat")
    g1_bytes = crs["bn254G1CompressedPoints"] * 32
    if os.path.isfile(g1) and os.path.getsize(g1) >= g1_bytes:
        check("crs bn254 g1 slice", crs["bn254G1CompressedSha256"], sha256_file(g1, g1_bytes))
    else:
        check("crs bn254 g1 slice", f"{g1} with at least {g1_bytes} bytes", "missing")
    check("crs bn254 g2", crs["bn254G2Sha256"], sha256_file(g2) if os.path.isfile(g2) else "missing")
    if os.path.isfile(grumpkin):
        check("crs grumpkin slice", crs["grumpkinG1Sha256"], sha256_file(grumpkin, crs["grumpkinG1Points"] * 64))
    else:
        print("skip   crs grumpkin slice (the EVM build doesn't read it)")

    vendored = os.path.join(a.root, lock["poseidon"]["path"])
    check("vendored poseidon tree", lock["poseidon"]["treeSha256"], tree_sha256(vendored) if os.path.isdir(vendored) else "missing")

    sdk = os.path.join(a.root, "packages/private-sdk/package.json")
    deps = load(sdk).get("dependencies", {}) if os.path.isfile(sdk) else {}
    for pkg, version in sorted(lock["js"].items()):
        check(f"js {pkg}", version, deps.get(pkg, "missing"))

    if os.path.isdir(os.path.join(a.root, ".git")) or os.path.isfile(os.path.join(a.root, ".git")):
        for path, pinned in sorted(lock["submodules"].items()):
            tree = run(["git", "-C", a.root, "ls-tree", "HEAD", path]).split()
            check(f"submodule {path} at HEAD", pinned, tree[2] if len(tree) > 2 else "missing")
            sub = os.path.join(a.root, path)
            check(f"submodule {path} checkout", pinned, run(["git", "-C", sub, "rev-parse", "HEAD"]).strip())
            status = run(["git", "-C", sub, "--no-optional-locks", "status", "--porcelain"]).strip()
            check(f"submodule {path} clean", "clean", "clean" if not status else "modified")
    else:
        print("skip   submodules (not a git checkout; the caller extracted them at the pinned commits)")

    if a.observed:
        dump({k: observed[k] for k in ("bb", "forge", "noirc", "solc")}, a.observed)
    if drift:
        print(f"{len(drift)} toolchain item(s) drift from {a.lock}")
        sys.exit(1)


# ----------------------------------------------------------------------------------------------------------- circuits


def cmd_circuits(a):
    with open(os.path.join(a.dir, "Nargo.toml"), "rb") as f:
        members = tomllib.load(f)["workspace"]["members"]
    for m in members:
        with open(os.path.join(a.dir, m, "Nargo.toml"), "rb") as f:
            package = tomllib.load(f)["package"]
        if package.get("type") == "bin" and m not in EXCLUDED_CIRCUITS:
            print(m)


def verifier_constants(source, name):
    consts = {k: v for k, v in re.findall(r"^uint256 constant (\w+) = (0x[0-9a-fA-F]+|\d+);$", source, re.M)}
    libra = re.search(r"uint256 internal constant LIBRA_COMMITMENTS = (\d+);", source)
    # The runtime holds $MSMSize, computed in the constructor. Recompute it the same way and refuse to guess if bb's
    # template changed.
    template = (
        "uint256 constant NUMBER_UNSHIFTED_ZK = NUMBER_UNSHIFTED + NUM_MASKING_POLYNOMIALS;" in source
        and "$MSMSize = NUMBER_UNSHIFTED_ZK + _logN + LIBRA_COMMITMENTS + 2;" in source
    )
    needed = ("N", "LOG_N", "NUMBER_OF_PUBLIC_INPUTS", "VK_HASH", "NUMBER_UNSHIFTED", "NUM_MASKING_POLYNOMIALS")
    if not template or not libra or any(k not in consts for k in needed):
        fail(f"{name}: the verifier template differs from bb 5.3.0; update verifier_constants in scripts/repro.py")
    c = {k: int(consts[k], 0) for k in needed}
    msm = c["NUMBER_UNSHIFTED"] + c["NUM_MASKING_POLYNOMIALS"] + c["LOG_N"] + int(libra.group(1)) + 2
    return c, msm


def cmd_circuit_entries(a):
    entries = {}
    for c in a.circuits:
        artifact = load(os.path.join(a.target, f"{c}.json"))
        name = f"{camel(c)}Verifier"
        verifier = os.path.join(a.verifiers, f"{name}.sol")
        with open(verifier, encoding="utf-8") as f:
            source = f.read()
        with open(os.path.join(a.keys, c, "vk_hash"), "rb") as f:
            vk_hash = "0x" + f.read().hex()
        consts, msm = verifier_constants(source, name)
        if word(consts["VK_HASH"]) != vk_hash:
            fail(f"{name}: VK_HASH in the verifier doesn't match keys/{c}/vk_hash")
        entries[c] = {
            "abi_sha256": sha256_bytes(json.dumps(artifact["abi"], sort_keys=True, separators=(",", ":")).encode()),
            "acir_sha256": sha256_bytes(base64.b64decode(artifact["bytecode"])),
            "immutables": {
                "$LOG_N": word(consts["LOG_N"]),
                "$MSMSize": word(msm),
                "$N": word(consts["N"]),
                "$NUM_PUBLIC_INPUTS": word(consts["NUMBER_OF_PUBLIC_INPUTS"]),
                "$VK_HASH": vk_hash,
            },
            "log_n": consts["LOG_N"],
            "n": consts["N"],
            "num_public_inputs": consts["NUMBER_OF_PUBLIC_INPUTS"],
            "verifier": f"src/privacy/verifiers/{name}.sol:{name}",
            "verifier_sha256": sha256_file(verifier),
            "vk_hash": vk_hash,
            "vk_sha256": sha256_file(os.path.join(a.keys, c, "vk")),
        }
    dump(entries, a.out)


def cmd_toolchain_txt(a):
    lock = load(a.lock)
    entries = load(a.circuits_json)
    print(f"nargo {lock['nargo']['version']}")
    print(f"bb {lock['bb']['version']}")
    for c in a.circuits:
        e = entries[c]
        print(f"{c} acir_sha256={e['acir_sha256']} vk_hash={e['vk_hash']} verifier_sha256={e['verifier_sha256']}")


# ---------------------------------------------------------------------------------------------------------- contracts


def ast_index(sources):
    """AST id -> (kind, name, scope) for contracts and immutable variables in one compiler job."""
    index = {}

    def walk(node):
        if isinstance(node, dict):
            if node.get("nodeType") == "ContractDefinition":
                index[node["id"]] = ("contract", node["name"], node.get("contractKind"))
            elif node.get("nodeType") == "VariableDeclaration" and node.get("mutability") == "immutable":
                index[node["id"]] = ("immutable", node["name"], node.get("scope"))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    for s in sources.values():
        walk(s["ast"])
    return index


def zero(code, start, length):
    return code[: 2 * start] + "00" * length + code[2 * (start + length) :]


def link_offsets(link_refs):
    return {f"{f}:{lib}": sorted(r["start"] for r in refs) for f, libs in link_refs.items() for lib, refs in libs.items()}


def mask_runtime(code, entry):
    for starts in entry["link_offsets"].values():
        for s in starts:
            code = zero(code, s, 20)
    for starts in entry["immutable_offsets"].values():
        for s in starts:
            code = zero(code, s, 32)
    for s, length in entry["self_address_offsets"]:
        code = zero(code, s, length)
    return code


def self_address_slot(address, length):
    return "0x" + address[2:].lower().rjust(2 * length, "0")


def cmd_contract_entries(a):
    jobs = []
    for name in sorted(os.listdir(a.build_info)):
        info = load(os.path.join(a.build_info, name))
        jobs.append(("via-ir" if info["input"]["settings"].get("viaIR") else "legacy", info["output"]))

    wanted = set(PROTOCOL_CONTRACTS) | {f"src/privacy/verifiers/{camel(c)}Verifier.sol:{camel(c)}Verifier" for c in a.circuits}
    entries = {}
    os.makedirs(a.runtime_dir, exist_ok=True)
    pending = sorted(wanted)
    seen = set()
    while pending:
        fq = pending.pop()
        if fq in seen:
            continue
        seen.add(fq)
        path, contract = fq.rsplit(":", 1)
        variants = {}
        for profile, output in jobs:
            out = output.get("contracts", {}).get(path, {}).get(contract)
            if not out:
                continue
            index = ast_index(output["sources"])
            kinds = {v[1]: v[2] for v in index.values() if v[0] == "contract"}
            names = {k: v for k, v in index.items() if v[0] == "contract"}
            evm = out["evm"]
            initcode = re.sub(r"__\$[0-9a-f]{34}\$__", "0" * 40, evm["bytecode"]["object"])
            runtime = re.sub(r"__\$[0-9a-f]{34}\$__", "0" * 40, evm["deployedBytecode"]["object"])
            library = kinds.get(contract) == "library"
            immutables = {}
            self_address = []
            for ast_id, refs in evm["deployedBytecode"].get("immutableReferences", {}).items():
                if ast_id == VIA_IR_LIBRARY_ADDRESS:
                    self_address = sorted([r["start"], r["length"]] for r in refs)
                    continue
                _, var, scope = index[int(ast_id)]
                immutables[f"{names[scope][1]}.{var}"] = sorted(r["start"] for r in refs)
            # via-IR leaves call protection out when every external function is view or pure.
            if library and profile == "legacy":
                if not runtime.startswith(LIBRARY_PREFIX):
                    fail(f"{fq}: library runtime doesn't start with PUSH20 <address>")
                self_address = [[1, 20]]
            entry = {
                "code_size": len(runtime) // 2,
                "immutable_offsets": immutables,
                "initcode_hash": keccak(initcode),
                "library": library,
                "link_offsets": link_offsets(evm["deployedBytecode"]["linkReferences"]),
                "self_address_offsets": self_address,
            }
            masked = mask_runtime(runtime, entry)
            entry["runtime_masked_hash"] = keccak(masked)
            with open(os.path.join(a.runtime_dir, f"{entry['runtime_masked_hash']}.hex"), "w", encoding="utf-8") as f:
                f.write(masked + "\n")
            variants[profile] = entry
            pending.extend(entry["link_offsets"])
        if not variants:
            fail(f"{fq} is missing from the forge build")
        entries[fq] = variants
    dump(entries, a.out)


# ----------------------------------------------------------------------------------------------------------- manifest


def cmd_manifest(a):
    manifest = {
        "circuits": load(a.circuits_json),
        "dirty": a.dirty == "true",
        "official": a.official == "true",
        "sourceCommit": a.commit,
        "toolchain": load(a.observed),
        "toolchainLockSha256": sha256_file(a.lock),
    }
    if a.contracts_json:
        manifest["contracts"] = load(a.contracts_json)
    dump(manifest, a.out)
    print(f"{'circuit':<16} {'acir_sha256':<16} {'vk_hash':<18} {'n':>6} {'pub':>4}  verifier_sha256")
    for c, e in sorted(manifest["circuits"].items()):
        print(f"{c:<16} {e['acir_sha256'][:16]} {e['vk_hash'][:18]} {e['n']:>6} {e['num_public_inputs']:>4}  {e['verifier_sha256'][:16]}")
    rows = set()
    for fq, variants in manifest.get("contracts", {}).items():
        for profile, e in variants.items():
            rows.add((fq.rsplit(":", 1)[1], profile, e["code_size"], e["runtime_masked_hash"]))
    for name, profile, size, masked in sorted(rows):
        print(f"{name:<24} {profile:<7} {size:>6} bytes  masked {masked[:18]}")


# ------------------------------------------------------------------------------------------------------------- record


def cmd_record(a):
    manifest = load(a.manifest)
    run_file = load(a.broadcast)
    record = load(a.record)
    if "contracts" not in manifest:
        fail("the manifest has no contracts block; rebuild without --circuits-only")

    def runtime(entry):
        with open(os.path.join(a.runtime_dir, f"{entry['runtime_masked_hash']}.hex"), encoding="utf-8") as f:
            return f.read().strip()

    def fill(code, entry, links, immutables, own=None):
        for fq, starts in entry["link_offsets"].items():
            for s in starts:
                code = code[: 2 * s] + links[fq.rsplit(":", 1)[1]][2:].lower() + code[2 * (s + 20) :]
        for name, starts in entry["immutable_offsets"].items():
            value = immutables[name.rsplit(".", 1)[1]][2:]
            for s in starts:
                code = code[: 2 * s] + value + code[2 * (s + 32) :]
        if own:
            for s, length in entry["self_address_offsets"]:
                code = code[: 2 * s] + self_address_slot(own, length)[2:] + code[2 * (s + length) :]
        return code

    def deployed_variant(fq, address):
        variants = manifest["contracts"][fq]
        profile, entry = match_variant(variants, chain_code(a.rpc, address))
        if entry is None:
            print(f"warning: code at {address} doesn't match any build of {fq}", file=sys.stderr)
            profile, entry = sorted(variants.items())[0]
        return profile, entry

    creates = {}
    for tx in run_file["transactions"]:
        if tx.get("transactionType") in ("CREATE", "CREATE2") and tx.get("contractName"):
            creates[tx["contractName"]] = tx

    libraries = {}
    for entry in run_file.get("libraries", []):
        path, name, address = entry.split(":")
        if name in libraries:
            continue
        fq = f"{path}:{name}"
        if fq not in manifest["contracts"]:
            fail(f"{fq} from the broadcast isn't in the manifest")
        address = run_file_address(address)
        profile, built = deployed_variant(fq, address)
        libraries[name] = {
            "address": address,
            "artifact": fq,
            "deployTx": creates.get(name, {}).get("hash"),
            "profile": profile,
            "runtimeHash": keccak(fill(runtime(built), built, {}, {}, own=address)),
            "runtimeMaskedHash": built["runtime_masked_hash"],
        }
    links = {n: lib["address"] for n, lib in libraries.items()}

    addresses = {key: run_file_address(record[key]) for key in WIRING if key in record}
    wired = {}
    for key, getters in WIRING.items():
        for getter, circuit in getters.items():
            wired.setdefault(circuit, []).append({"contract": key, "getter": getter})

    verifiers = {}
    for name, tx in sorted(creates.items()):
        if not name.endswith("Verifier"):
            continue
        circuit = snake(name[: -len("Verifier")])
        c = manifest["circuits"].get(circuit)
        if c is None:
            fail(f"{name} was deployed but {circuit} isn't in the manifest")
        address = run_file_address(tx["contractAddress"])
        profile, built = deployed_variant(c["verifier"], address)
        verifiers[circuit] = {
            "abiSha256": c["abi_sha256"],
            "acirSha256": c["acir_sha256"],
            "address": address,
            "contract": name,
            "deployTx": tx["hash"],
            "profile": profile,
            "runtimeHash": keccak(fill(runtime(built), built, links, c["immutables"])),
            "runtimeMaskedHash": built["runtime_masked_hash"],
            "verifierSha256": c["verifier_sha256"],
            "vkHash": c["vk_hash"],
            "vkSha256": c["vk_sha256"],
            "wiredAt": [w for w in wired.get(circuit, []) if w["contract"] in addresses],
        }

    contracts = {}
    for key, name in RECORD_CONTRACTS.items():
        if key not in addresses:
            continue
        fq = next(f for f in PROTOCOL_CONTRACTS if f.endswith(f":{name}"))
        contracts[name] = {
            "address": addresses[key],
            "artifact": fq,
            "deployTx": creates.get(name, {}).get("hash"),
            "maskedHashes": {p: e["runtime_masked_hash"] for p, e in sorted(manifest["contracts"][fq].items())},
            "recordKey": key,
        }

    record["build"] = {
        "manifestSha256": sha256_file(a.manifest),
        "official": manifest["official"],
        "sourceCommit": manifest["sourceCommit"],
        "toolchain": manifest["toolchain"],
        "toolchainLockSha256": manifest["toolchainLockSha256"],
    }
    # Keep fields the deploy script already wrote (runtimeCodehash and the like) next to the ones added here.
    for block, entries in (("libraries", libraries), ("verifiers", verifiers), ("contracts", contracts)):
        existing = record.get(block, {})
        record[block] = {k: {**existing.get(k, {}), **v} for k, v in entries.items()}
    dump(record, a.out)


def run_file_address(address):
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
        fail(f"not an address: {address}")
    return run(["cast", "to-check-sum-address", address]).strip()


# ------------------------------------------------------------------------------------------------------------- verify


def chain_code(rpc, address):
    code = run(["cast", "code", address, "--rpc-url", rpc]).strip().lower()
    return code[2:] if code.startswith("0x") else code


def match_variant(variants, code):
    for profile, entry in sorted(variants.items()):
        if len(code) // 2 == entry["code_size"] and keccak(mask_runtime(code, entry)) == entry["runtime_masked_hash"]:
            return profile, entry
    return None, None


def cmd_verify(a):
    record = load(a.record)
    build = record.get("build")
    if not build:
        print("FAIL record has no build block: it predates reproducible builds, so nothing ties it to a source commit")
        sys.exit(2)
    manifest = load(a.manifest)
    failures = []

    def report(ok, msg):
        print(f"{'PASS' if ok else 'FAIL'} {msg}")
        if not ok:
            failures.append(msg)

    def cast(*args):
        return run(["cast", *args, "--rpc-url", a.rpc]).strip()

    def slot(code, start, length):
        return "0x" + code[2 * start : 2 * (start + length)]

    def same_address(x, y):
        return x.lower() == y.lower()

    def check_links(label, code, entry):
        for fq, starts in sorted(entry["link_offsets"].items()):
            lib = fq.rsplit(":", 1)[1]
            expected = record["libraries"].get(lib, {}).get("address", "unrecorded")
            got = {slot(code, s, 20) for s in starts}
            report(len(got) == 1 and same_address(got.pop(), expected), f"{label} links {lib} at {expected}")

    report(sha256_file(a.manifest) == build["manifestSha256"], f"manifest sha256 equals the record ({build['manifestSha256'][:16]})")
    report(manifest["sourceCommit"] == build["sourceCommit"], f"manifest built from {build['sourceCommit']}")
    report(manifest["toolchainLockSha256"] == build["toolchainLockSha256"], "toolchain lock matches the record")
    report(manifest["official"] and not manifest["dirty"], "manifest is official (clean tree, no toolchain drift)")
    report(cast("chain-id") == str(record["chainId"]), f"rpc serves chain {record['chainId']}")

    for name, lib in sorted(record.get("libraries", {}).items()):
        code = chain_code(a.rpc, lib["address"])
        profile, entry = match_variant(manifest["contracts"][lib["artifact"]], code)
        report(entry is not None, f"library {name} {lib['address']}: masked runtime matches {lib['artifact']}" + (f" ({profile})" if profile else ""))
        if entry:
            ok = all(slot(code, s, n) == self_address_slot(lib["address"], n) for s, n in entry["self_address_offsets"])
            report(ok, f"library {name}: call-protection slot holds its own address")
        report(keccak(code) == lib["runtimeHash"], f"library {name}: code hash equals runtimeHash")

    for circuit, v in sorted(record.get("verifiers", {}).items()):
        c = manifest["circuits"].get(circuit)
        if c is None:
            report(False, f"verifier {circuit}: circuit missing from the manifest")
            continue
        for field, key in (("vkHash", "vk_hash"), ("vkSha256", "vk_sha256"), ("acirSha256", "acir_sha256"), ("verifierSha256", "verifier_sha256")):
            report(v.get(field) == c[key], f"verifier {circuit}: record {field} equals manifest")
        code = chain_code(a.rpc, v["address"])
        profile, entry = match_variant(manifest["contracts"][c["verifier"]], code)
        report(entry is not None, f"verifier {circuit} {v['address']}: masked runtime matches {v['contract']}")
        if entry is None:
            continue
        check_links(f"verifier {circuit}", code, entry)
        for name, starts in sorted(entry["immutable_offsets"].items()):
            short = name.rsplit(".", 1)[1]
            got = {slot(code, s, 32) for s in starts}
            expected = c["immutables"].get(short)
            report(len(got) == 1 and got.pop() == expected, f"verifier {circuit}: {short} = {expected}")
        report(keccak(code) == v["runtimeHash"], f"verifier {circuit}: full code hash equals runtimeHash")

    for name, item in sorted(record.get("contracts", {}).items()):
        code = chain_code(a.rpc, item["address"])
        profile, entry = match_variant(manifest["contracts"][item["artifact"]], code)
        report(entry is not None, f"{name} {item['address']}: masked runtime matches the build")
        if entry:
            check_links(name, code, entry)

    for circuit, v in sorted(record.get("verifiers", {}).items()):
        for w in v.get("wiredAt", []):
            target = record[w["contract"]]
            got = cast("call", target, f"{w['getter']}()(address)")
            report(same_address(got, v["address"]), f"{w['contract']}.{w['getter']}() returns the {circuit} verifier")

    if "pool" in record:
        expected = (int(record["chainId"]) << 160) | int(record["pool"], 16)
        for key in ("pool", "spot", "markets"):
            if key in record:
                got = int(cast("call", record[key], "deploymentId()(uint256)").split()[0])
                report(got == expected, f"{key}.deploymentId() = (chainId << 160) | pool")

    print(f"{len(failures)} check(s) failed" if failures else "all checks passed")
    sys.exit(1 if failures else 0)


# ---------------------------------------------------------------------------------------------------------------- cli


def main():
    p = argparse.ArgumentParser(prog="repro.py")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("solc-path")
    s.add_argument("--lock", required=True)
    s.set_defaults(fn=cmd_solc_path)

    s = sub.add_parser("toolchain-txt")
    s.add_argument("--lock", required=True)
    s.add_argument("--circuits-json", required=True)
    s.add_argument("circuits", nargs="+")
    s.set_defaults(fn=cmd_toolchain_txt)

    s = sub.add_parser("toolchain")
    s.add_argument("--lock", required=True)
    s.add_argument("--root", required=True)
    s.add_argument("--crs-dir", required=True)
    s.add_argument("--solc")
    s.add_argument("--observed")
    s.set_defaults(fn=cmd_toolchain)

    s = sub.add_parser("circuits")
    s.add_argument("--dir", required=True)
    s.set_defaults(fn=cmd_circuits)

    s = sub.add_parser("circuit-entries")
    s.add_argument("--target", required=True)
    s.add_argument("--keys", required=True)
    s.add_argument("--verifiers", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("circuits", nargs="+")
    s.set_defaults(fn=cmd_circuit_entries)

    s = sub.add_parser("contract-entries")
    s.add_argument("--build-info", required=True)
    s.add_argument("--runtime-dir", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("circuits", nargs="+")
    s.set_defaults(fn=cmd_contract_entries)

    s = sub.add_parser("manifest")
    s.add_argument("--circuits-json", required=True)
    s.add_argument("--contracts-json")
    s.add_argument("--observed", required=True)
    s.add_argument("--lock", required=True)
    s.add_argument("--commit", required=True)
    s.add_argument("--dirty", choices=("true", "false"), required=True)
    s.add_argument("--official", choices=("true", "false"), required=True)
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_manifest)

    s = sub.add_parser("record")
    s.add_argument("--manifest", required=True)
    s.add_argument("--rpc", required=True)
    s.add_argument("--runtime-dir", required=True)
    s.add_argument("--broadcast", required=True)
    s.add_argument("--record", required=True)
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_record)

    s = sub.add_parser("verify")
    s.add_argument("--record", required=True)
    s.add_argument("--manifest", required=True)
    s.add_argument("--rpc", required=True)
    s.set_defaults(fn=cmd_verify)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
