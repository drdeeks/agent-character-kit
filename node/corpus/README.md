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

Index it via the library (not currently exposed as an `ack` CLI command —
knowledge indexing/semantic search is a separate skill from character
enforcement, see `HABIT_POLICY.md` §3):

```js
import { DocumentIndexer, SemanticSearch } from "agent-character-kit";

const indexer = new DocumentIndexer(process.cwd());
await indexer.init();
await indexer.indexDirectory("./corpus", {});   // or indexer.indexFile(path, {})
const keywordResults = await indexer.search("your question");

const semantic = new SemanticSearch(process.cwd());
await semantic.init();
await semantic.hybridSearch("your question", keywordResults);
```
