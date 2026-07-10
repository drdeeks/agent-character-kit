"""
Semantic search — vector embeddings over indexed chunks, with hybrid (semantic +
keyword) ranking via Reciprocal Rank Fusion.

Mirrors the Node `src/knowledge/semantic.js`. Fully optional: the embedding model
(`@xenova/transformers` in Node, `transformers`/sentence-transformers in Python) is
loaded lazily and only when actually needed, so this component is bypassed entirely
if you don't use it.
"""

from __future__ import annotations
import json
import math
from pathlib import Path
from datetime import datetime, timezone


class SemanticSearch:
    def __init__(self, workspace: str):
        self.workspace = str(workspace)
        self.vectors_dir = Path(workspace) / "knowledge" / "vectors"
        self.embedder = None
        self.vectors = {}

    def init(self):
        self.vectors_dir.mkdir(parents=True, exist_ok=True)
        try:
            raw = (self.vectors_dir / "vectors.json").read_text(encoding="utf-8")
            self.vectors = json.loads(raw)
        except (FileNotFoundError, json.JSONDecodeError):
            self.vectors = {}

    async def load_embedder(self):
        if self.embedder:
            return self.embedder
        # Lazy, optional dependency.
        from sentence_transformers import SentenceTransformer
        self.embedder = SentenceTransformer("all-MiniLM-L6-v2")
        return self.embedder

    def _embed_sync(self, text):
        """Synchronous embedding (sentence-transformers is sync)."""
        import asyncio
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
        return loop.run_until_complete(self.embed(text))

    async def embed(self, text):
        model = await self.load_embedder()
        vec = model.encode(text, normalize_embeddings=True)
        return list(vec)

    @staticmethod
    def cosine_similarity(a, b):
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(x * x for x in b))
        if na == 0 or nb == 0:
            return 0.0
        return dot / (na * nb)

    def index_document(self, doc_id, text, metadata=None):
        metadata = metadata or {}
        chunk_size, overlap = 3500, 350
        chunks = []
        if len(text) <= chunk_size:
            chunks.append({"id": doc_id, "text": text, "metadata": metadata})
        else:
            start = 0
            i = 0
            while start < len(text):
                end = min(start + chunk_size, len(text))
                chunks.append({"id": f"{doc_id}:chunk-{i}", "text": text[start:end],
                               "metadata": {**metadata, "parent": doc_id, "chunkIndex": i}})
                start = end - overlap
                i += 1
                if start + overlap >= len(text):
                    break
        for ch in chunks:
            self.vectors[ch["id"]] = {
                "embedding": self._embed_sync(ch["text"]),
                "text": ch["text"][:200],
                "metadata": ch["metadata"],
            }
        return len(chunks)

    def save(self):
        (self.vectors_dir / "vectors.json").write_text(json.dumps(self.vectors))

    def search(self, query, limit=10):
        q = self._embed_sync(query)
        results = []
        for cid, entry in self.vectors.items():
            results.append({"id": cid, "score": self.cosine_similarity(q, entry["embedding"]),
                            "text": entry["text"], "metadata": entry["metadata"]})
        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:limit]

    def hybrid_search(self, query, keyword_results, limit=10):
        semantic = self.search(query, limit * 2)
        rrf = {}
        k = 60
        for i, kr in enumerate(keyword_results):
            rid = kr.get("docId") or kr.get("id")
            rrf[rid] = rrf.get(rid, 0) + 1 / (k + i + 1)
        for i, sr in enumerate(semantic):
            rid = sr["metadata"].get("parent") or sr["id"]
            rrf[rid] = rrf.get(rid, 0) + 1 / (k + i + 1)
        sorted_ids = sorted(rrf.items(), key=lambda x: x[1], reverse=True)[:limit]
        out = []
        for rid, score in sorted_ids:
            entry = self.vectors.get(rid, {})
            out.append({"id": rid, "rrfScore": score, "text": entry.get("text", ""),
                        "metadata": entry.get("metadata", {})})
        return out

    def status(self):
        try:
            from sentence_transformers import SentenceTransformer  # noqa
            available = True
        except ImportError:
            available = False
        return {"vectors": len(self.vectors), "semanticAvailable": available,
                "vectorsDir": str(self.vectors_dir)}
