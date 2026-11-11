---
name: paper-picnic
description: Use when the user asks for the latest or this week's academic papers in political science, economics, sociology, international relations, public administration, communication studies, environmental studies, migration studies, multidisciplinary journals, or SocArXiv working papers. Never invent paper data; cite DOIs from the tools.
---

# Paper Picnic

Call these tools when the user wants this week's (or the latest) papers from Paper Picnic. Do not invent titles, authors, abstracts, or DOIs — only report what the tools return, and cite each paper's DOI.

## When to call which tool

- **list_categories** — the user asks which fields or feeds are available, or you need slugs and last-updated dates before fetching.
- **get_papers** — the user wants the latest / this week's papers in a named field (for example political science, econ, sociology). Pass the category slug. Optionally filter by journal name substring and set `limit` (default 20).
- **search_papers** — the user asks for papers about a topic or keyword, possibly across several or all categories. Match is case-insensitive over title, abstract, authors, journal, and subjects.

Feeds refresh every Friday at 02:00 UTC with the previous seven days of publications. If a category is unknown, show the error and the valid slugs rather than guessing.
