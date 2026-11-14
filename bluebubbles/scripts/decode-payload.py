#!/usr/bin/env python3 -I
"""Decode a Messages balloon payload (base64) into readable JSON.

Handles NSKeyedArchiver archives (resolves $objects/UIDs, NSDictionary, NSArray, NSString,
NSData, NSURL, NSUUID) and plain binary/XML plists. Unknown classes are shown with their
class name and raw fields so nothing is hidden.

Usage: python3 -I scripts/decode-payload.py <base64>      (or pipe base64 on stdin)
"""
import base64, json, plistlib, sys


def resolve(objs, ref, seen=None):
    seen = seen or set()
    if isinstance(ref, plistlib.UID):
        idx = ref.data
        if idx in seen:
            return f"<cycle #{idx}>"
        seen = seen | {idx}
        return resolve(objs, objs[idx], seen)
    if isinstance(ref, dict):
        cls = None
        if "$class" in ref:
            cls_obj = objs[ref["$class"].data]
            cls = (cls_obj.get("$classname") if isinstance(cls_obj, dict) else None)
        if cls in ("NSDictionary", "NSMutableDictionary"):
            keys = [resolve(objs, k, seen) for k in ref.get("NS.keys", [])]
            vals = [resolve(objs, v, seen) for v in ref.get("NS.objects", [])]
            return {str(k): v for k, v in zip(keys, vals)}
        if cls in ("NSArray", "NSMutableArray", "NSSet", "NSMutableSet", "NSOrderedSet"):
            return [resolve(objs, v, seen) for v in ref.get("NS.objects", [])]
        if cls in ("NSString", "NSMutableString"):
            return ref.get("NS.string")
        if cls in ("NSData", "NSMutableData"):
            return decode_bytes(ref.get("NS.data", b""))
        if cls == "NSUUID":
            b = ref.get("NS.uuidbytes", b"")
            return "uuid:" + b.hex() if isinstance(b, bytes) else b
        if cls == "NSURL":
            return {"$url": resolve(objs, ref.get("NS.relative"), seen)}
        if cls == "NSDate":
            return {"$date": ref.get("NS.time")}
        out = {k: resolve(objs, v, seen) for k, v in ref.items() if k != "$class"}
        if cls:
            out["$class"] = cls
        return out
    if isinstance(ref, list):
        return [resolve(objs, v, seen) for v in ref]
    if isinstance(ref, bytes):
        return decode_bytes(ref)
    if ref == "$null":
        return None
    return ref


def decode_bytes(b: bytes):
    if b[:6] == b"bplist" or b[:5] == b"<?xml":
        try:
            return {"$plist": decode_plist(b)}
        except Exception:
            pass
    try:
        s = b.decode("utf-8")
        if s.isprintable():
            return s
    except UnicodeDecodeError:
        pass
    return {"$base64": base64.b64encode(b).decode()}


def decode_plist(b: bytes):
    p = plistlib.loads(b)
    if isinstance(p, dict) and p.get("$archiver") == "NSKeyedArchiver":
        return {"$archive": resolve(p["$objects"], p["$top"].get("root", next(iter(p["$top"].values()))))}
    return jsonable(p)


def jsonable(o):
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, list):
        return [jsonable(v) for v in o]
    if isinstance(o, bytes):
        return decode_bytes(o)
    if isinstance(o, plistlib.UID):
        return f"UID({o.data})"
    if hasattr(o, "isoformat"):
        return o.isoformat()
    return o


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    raw = base64.b64decode(arg.strip())
    print(json.dumps(decode_bytes(raw), indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
