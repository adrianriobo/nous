# Personal knowledge wiki

Mount an [OKF 2.0](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) wiki at `/sandbox/wiki`. The router registers three wiki tools when the directory exists.

```bash
podman run --rm -it \
  --env ENMAAS_BASE_URL \
  --env ENMAAS_API_KEY \
  -v /path/to/wiki:/sandbox/wiki:z \
  ghcr.io/adrianriobo/nous:latest
```

Set `WIKI_PATH` to use another path inside the container. Mount that path as well.

| Tool | Purpose |
|---|---|
| `wiki_search` | Find Markdown pages by text in the title, description, tags, or body. The search excludes `raw/`. |
| `wiki_read` | Read a page by its relative path. |
| `wiki_ingest` | Save a source document in `raw/assets/` for a separate processor. |

The search matches the complete query string. Use several short queries when a search gives no useful result. The search is not semantic.

The wiki can follow the [LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), with an index, curated pages, and raw source documents. `wiki_ingest` does not update the curated pages or run the processor. The processor must run separately. The wiki mount must permit writes for ingestion.

For a large research task, request the `wiki-researcher` subagent. It uses read-only wiki tools and returns a summary. Verify important findings against the cited pages. See [subagents](subagents.md#wiki-researcher).
