"""
mneme.py — a tiny, dependency-free memory layer for LLM agents (stdlib-only Python twin).

Two things live on disk, no vector DB / embedder / server required:
  - STORAGE: plain files — robust, offline, $0.
       core memory  -> data/core-memory.json  (self-editing always-in-context blocks)
       archival     -> data/archival.jsonl     (append-only long-term log)
  - RECALL: a cheap, dependency-free keyword/recency search. For LLM-reranked recall, use the
       Node twin (lib/mneme.cjs) with MNEME_RERANKER set — both read/write the SAME data files.

No third-party imports. No network. Shares data/ byte-for-byte with lib/mneme.cjs.

CLI:  health | core-get [name] | core-set <name> <val> | core-append <name> <val>
      prompt | remember <text> | recall <query> [k]
"""
import os, sys, json, time, re

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_DATA_DIR = os.environ.get("MNEME_DATA_DIR") or os.path.join(_ROOT, "data")
_CORE_PATH = os.path.join(_DATA_DIR, "core-memory.json")
_ARCHIVAL_PATH = os.path.join(_DATA_DIR, "archival.jsonl")
# Neutral placeholders — overwrite them for your agent with core_set().
_DEFAULT_BLOCKS = {
    "persona": "I am a helpful assistant. I keep my memory honest and up to date.",
    "human": "The person I work with. (Set this with core-set human \"...\".)",
    "context": "",
}
_STOP = set("the a an and or of to in on for with is are was were be been it this that as at by from we you i our your".split())


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _tok(s):
    return [w for w in re.findall(r"[a-z0-9]+", str(s).lower()) if w not in _STOP and len(w) > 2]


class Mneme:
    def __init__(self):
        os.makedirs(_DATA_DIR, exist_ok=True)
        self.blocks = dict(_DEFAULT_BLOCKS)
        if os.path.exists(_CORE_PATH):
            try:
                self.blocks.update(json.load(open(_CORE_PATH, encoding="utf-8")))
            except Exception:
                pass

    # ---------- CORE MEMORY (self-editing, always in context) ----------
    def _persist(self):
        tmp = _CORE_PATH + ".tmp"
        json.dump(self.blocks, open(tmp, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
        os.replace(tmp, _CORE_PATH)  # atomic (safe on synced drives)

    def core_get(self, name=None):
        return self.blocks if name is None else self.blocks.get(name, "")

    def core_set(self, name, value):
        self.blocks[name] = str(value); self.blocks["_updated"] = _now(); self._persist()
        return self.blocks[name]

    def core_append(self, name, text, cap=4000):
        cur = self.blocks.get(name, "")
        self.blocks[name] = (cur + ("\n" if cur else "") + str(text))[-cap:]
        self.blocks["_updated"] = _now(); self._persist()
        return self.blocks[name]

    def memory_prompt(self):
        out = []
        for k, v in self.blocks.items():
            if k.startswith("_") or not v:
                continue
            out.append("<%s>\n%s\n</%s>" % (k, v, k))
        return "\n".join(out)

    # ---------- ARCHIVAL (file-based, no vector DB) ----------
    def archival_insert(self, text, meta=None):
        rec = {"ts": _now(), "text": str(text)}
        if meta:
            rec["meta"] = meta
        with open(_ARCHIVAL_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return rec["ts"]

    def _all_archival(self):
        if not os.path.exists(_ARCHIVAL_PATH):
            return []
        out = []
        for line in open(_ARCHIVAL_PATH, encoding="utf-8"):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
        return out

    def archival_search(self, query, k=5):
        """Dependency-free keyword/recency recall (LLM-reranked recall lives in the Node twin)."""
        q = set(_tok(query))
        rows = self._all_archival()
        scored = []
        for idx, r in enumerate(rows):
            toks = set(_tok(r.get("text", "")))
            overlap = len(q & toks)
            recency = idx / max(1, len(rows))  # newer = higher
            score = overlap + 0.25 * recency
            if overlap or not q:
                scored.append((score, r))
        scored.sort(key=lambda x: -x[0])
        return [r for _, r in scored[:k]]

    def remember(self, text, meta=None):
        return self.archival_insert(text, meta)

    def health(self):
        return {"ok": True, "engine": "files",
                "data_dir": _DATA_DIR,
                "core_blocks": [k for k in self.blocks if not k.startswith("_")],
                "archival_count": len(self._all_archival())}


def _main(argv):
    m = Mneme()
    if not argv or argv[0] == "health":
        print(json.dumps(m.health(), indent=2)); return
    cmd = argv[0]
    if cmd == "core-get":
        print(json.dumps(m.core_get(argv[1] if len(argv) > 1 else None), indent=2, ensure_ascii=False))
    elif cmd == "core-set":
        print(m.core_set(argv[1], argv[2]))
    elif cmd == "core-append":
        print(m.core_append(argv[1], argv[2]))
    elif cmd == "prompt":
        print(m.memory_prompt())
    elif cmd == "remember":
        print(m.remember(argv[1], {"kind": "cli"}))
    elif cmd == "recall":
        k = int(argv[2]) if len(argv) > 2 else 5
        print(json.dumps(m.archival_search(argv[1], k), indent=2, ensure_ascii=False))
    else:
        print("usage: health | core-get [name] | core-set <name> <val> | core-append <name> <val> | prompt | remember <text> | recall <query> [k]")


if __name__ == "__main__":
    _main(sys.argv[1:])
