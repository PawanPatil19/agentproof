#!/usr/bin/env python3
"""
Independent check of docs/spec/receipt-vectors.json, written from
docs/RECEIPT_SPEC.md alone (no AgentProof code). It shows the format can
be verified without TypeScript.

    python3 docs/spec/verify_vectors.py [path/to/receipt-vectors.json]

Uses only the standard library, plus the `cryptography` package for the
Ed25519 step when it is installed (that step is skipped otherwise).
"""
import base64
import hashlib
import hmac
import json
import math
import sys
from pathlib import Path


# ── RFC 8785 canonical JSON ────────────────────────────────────────────────

def jcs_number(x):
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    if isinstance(x, int):
        if abs(x) <= 2**53:
            return str(x)
        x = float(x)  # JSON numbers are IEEE 754 doubles
    if not math.isfinite(x):
        raise ValueError("non-finite numbers are not allowed")
    if x == 0:
        return "0"
    if x == int(x) and abs(x) <= 2**53:
        return str(int(x))
    # ECMAScript Number::toString: shortest round-trip digits, then layout.
    r = repr(x)
    mantissa, _, exp = r.partition("e")
    sign = "-" if mantissa.startswith("-") else ""
    mantissa = mantissa.lstrip("-")
    int_part, _, frac = mantissa.partition(".")
    digits = (int_part + frac).lstrip("0")
    point = len(int_part) + (int(exp) if exp else 0)
    if int_part == "0" or int_part == "":
        stripped = frac.lstrip("0")
        point = -(len(frac) - len(stripped)) + (int(exp) if exp else 0)
        digits = stripped
    digits = digits.rstrip("0") or "0"
    k, n = len(digits), point
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def jcs_string(s):
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif c < 0x20:
            out.append("\\u%04x" % c)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def jcs(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return jcs_number(v)
    if isinstance(v, str):
        return jcs_string(v)
    if isinstance(v, list):
        return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=lambda k: k.encode("utf-16-be"))  # UTF-16 code unit order
        return "{" + ",".join(jcs_string(k) + ":" + jcs(v[k]) for k in keys) + "}"
    raise TypeError(type(v))


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ── AgentProof receipt rules (docs/RECEIPT_SPEC.md) ───────────────────────

def claim_salt(key, nonce, claim_id):
    msg = b"agentproof.claim-salt/v2\x00" + nonce.encode() + b"\x00" + claim_id.encode()
    return hmac.new(key, msg, hashlib.sha256).digest()


def commit(salt, text):
    return "hmac-sha256:" + hmac.new(salt, text.encode("utf-8"), hashlib.sha256).hexdigest()


def receipt_sha256(receipt):
    body = {k: v for k, v in receipt.items() if k not in ("receipt_sha256", "signature")}
    return sha256_hex(jcs(body))


def statement(receipt):
    predicate = {k: v for k, v in receipt.items() if k != "signature"}
    return {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [{"name": "output", "digest": {"sha256": receipt["output_sha256"]}}],
        "predicateType": "https://agentproof.dev/receipt/v2",
        "predicate": predicate,
    }


def pae(payload_type, payload):
    t = payload_type.encode("utf-8")
    return b"DSSEv1 %d %s %d %s" % (len(t), t, len(payload), payload)


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("receipt-vectors.json")
    v = json.loads(path.read_text("utf-8"))
    n = 0

    for case in v["canonical_json"]:
        got = jcs(json.loads(case["input_json"]))
        assert got == case["canonical"], (case["name"], got)
        assert sha256_hex(got) == case["sha256"], case["name"]
        n += 1

    key = bytes.fromhex(v["keys"]["commitment_key_hex"])
    for case in v["claim_commitments"]:
        salt = claim_salt(key, case["commitment_nonce"], case["claim_id"])
        assert salt.hex() == case["salt"], case
        assert commit(salt, case["text"]) == case["text_commitment"], case
        n += 1

    r = v["receipt"]
    unsigned = r["unsigned_receipt"]
    assert receipt_sha256(unsigned) == r["receipt_sha256"] == unsigned["receipt_sha256"]
    payload = jcs(statement(r["signed_receipt"])).encode("utf-8")
    assert payload.decode("utf-8") == r["statement_canonical"]
    env = r["dsse_envelope"]
    assert env["payloadType"] == "application/vnd.in-toto+json"
    assert base64.b64decode(env["payload"]) == payload
    assert pae(env["payloadType"], payload).hex() == r["pae_hex"]
    d = r["disclosure"]
    claim = next(c for c in unsigned["claims"] if c["id"] == d["claim_id"])
    assert commit(bytes.fromhex(d["salt"]), d["text"]) == claim["text_commitment"]
    n += 5

    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_pem_public_key
    except ImportError:
        print(f"ok: {n} checks passed (Ed25519 skipped: pip install cryptography)")
        return
    pub = load_pem_public_key(v["keys"]["ed25519_public_key_pem"].encode())
    der = pub.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    assert hashlib.sha256(der).hexdigest()[:16] == v["keys"]["key_id"] == env["signatures"][0]["keyid"]
    sig = base64.b64decode(env["signatures"][0]["sig"])
    pub.verify(sig, pae(env["payloadType"], payload))  # raises on failure
    seed = bytes.fromhex(v["keys"]["ed25519_seed_hex"])
    assert Ed25519PrivateKey.from_private_bytes(seed).sign(pae(env["payloadType"], payload)) == sig
    n += 3
    print(f"ok: {n} checks passed, including Ed25519")


if __name__ == "__main__":
    main()
