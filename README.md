# Paper Picnic plugin

An [Agent Plugin](https://agent-plugins.org/specification) (MCP server + skill) that wraps [Paper Picnic](https://www.paper-picnic.com)'s public Markdown feeds. There is no JSON API and no authentication. Feeds at `https://www.paper-picnic.com/md/<slug>.md` refresh every Friday at 02:00 UTC with papers from the previous seven days.

This plugin is meant to be loaded by Cursor IDE (or another Agent Plugins client). Grok Bot does not load local plugins.

## Data shape

```ts
// One article or working paper from a weekly feed.
type Paper = {
  title: string;
  authors: string[];
  doi: string;
  abstract?: string;
  journal?: string;     // journal-article feeds only
  category: string;     // category slug
  subjects?: string[];  // working papers, when present
};

// Feed-level lastUpdated (YYYY-MM-DD) is returned alongside Paper[] in tool results.
```

## Tools

| Tool | Inputs | Output |
| --- | --- | --- |
| `list_categories` | *(none)* | `{ categories: { slug, name, lastUpdated }[] }` from the [AI index](https://www.paper-picnic.com/md/index.md) |
| `get_papers` | `category` (slug, required), `journal?` (case-insensitive substring), `limit?` (default 20) | `{ category, lastUpdated, papers: Paper[] }` |
| `search_papers` | `query` (required), `categories?` (slugs, default all), `limit?` (default 20) | `{ query, lastUpdatedByCategory, papers: Paper[] }` — case-insensitive match over title, abstract, authors, journal, and subjects |

Unknown category slugs return a clear error listing valid slugs. The server keeps a small in-memory cache for the process lifetime.

## Local install (Cursor IDE)

Copy this directory to `~/.cursor/plugins/local/paper-picnic` (copy, do not symlink from outside that folder), then reload the window. Confirm the skill and MCP server under Customize.

```bash
mkdir -p ~/.cursor/plugins/local
rm -rf ~/.cursor/plugins/local/paper-picnic
cp -R /path/to/paper-picnic-plugin ~/.cursor/plugins/local/paper-picnic
```

`mcp.json` uses `cwd: "${PLUGIN_ROOT}"` per the Agent Plugins schema. Cursor currently expands `${CURSOR_PLUGIN_ROOT}` but not `${PLUGIN_ROOT}`; if the server starts with the wrong working directory, launch it with `cwd` set to the plugin root or rely on the default (plugin root when `cwd` is omitted).

## Smoke test

```bash
node src/server.js
```

Speak newline-delimited JSON-RPC 2.0 on stdin (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`). Zero npm dependencies; Node 18+ (`global fetch`) is required.
