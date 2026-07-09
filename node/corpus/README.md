# Corpus — user-supplied informational material

Drop the documents, links, and examples you want the agent to **learn from** here.
This directory is the agent's *external* knowledge source.

- Plain docs, markdown, code samples, specs, reference material
- `llms.txt` / `agents.md` are parsed as curated reference manifests
- Links between docs (`[[wiki]]`, markdown, `doc:`/`ref:`, URLs) are documented and
  can be followed + indexed

**This is NOT where the agent's own files go.** The agent's identity (`SOUL.md`,
`constitution.yaml`), its habits, its memory, and its knowledge graph are kept in
dedicated directories (`.agent/`, `memory/`, `knowledge/`) and are **never indexed as
corpus**. Indexing only ever reads what you place here.

Index it with:

```
aik index run          # defaults to ./corpus
aik index run ./corpus
aik semantic index      # build vectors for semantic search
aik semantic hybrid "your question"
```
