#!/usr/bin/env node
"use strict";

/**
 * Paper Picnic MCP server (zero-dependency Node stdio JSON-RPC 2.0).
 *
 * Paper = {
 *   title: string,
 *   authors: string[],
 *   doi: string,
 *   abstract?: string,
 *   journal?: string,
 *   category: string,
 *   subjects?: string[]
 * }
 *
 * Tool results also include feed-level lastUpdated (YYYY-MM-DD).
 */

const readline = require("node:readline");

const SERVER_NAME = "paper-picnic";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const DEFAULT_PROTOCOL = "2025-03-26";
const INDEX_URL = "https://www.paper-picnic.com/md/index.md";
const DEFAULT_LIMIT = 20;
const USER_AGENT = `paper-picnic-plugin/${SERVER_VERSION}`;

/** @type {Map<string, { fetchedAt: number, value: any }>} */
const cache = new Map();

function log(...args) {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function success(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMessage({ jsonrpc: "2.0", id, error });
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/markdown, text/plain, */*",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit) return hit.value;
  const value = await loader();
  cache.set(key, { fetchedAt: Date.now(), value });
  return value;
}

function parseLastUpdated(markdown) {
  // Handles "Last updated: YYYY-MM-DD" and bold variants such as "**Last updated:** YYYY-MM-DD".
  const match = markdown.match(/Last updated[\s*:]*(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : null;
}

function parseLabeledLine(line) {
  const match = line.match(
    /^\s*(?:\*\*)?(Authors|DOI|Abstract|Subjects)(?:\*\*)?:\s*(.*)$/i
  );
  if (!match) return null;
  return { key: match[1].toLowerCase(), value: match[2] };
}

function parseDoi(value) {
  if (!value) return "";
  const linked = value.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (linked) return (linked[2] || linked[1]).trim();
  return value.trim();
}

function parseAuthors(value) {
  if (!value) return [];
  return value
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseSubjects(value) {
  if (!value) return [];
  return value
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function finishPaper(draft, category, journal) {
  if (!draft || !draft.title) return null;
  const paper = {
    title: draft.title,
    authors: Array.isArray(draft.authors) ? draft.authors : [],
    doi: draft.doi || "",
    category,
  };
  if (draft.abstract) paper.abstract = draft.abstract;
  if (journal) paper.journal = journal;
  if (draft.subjects && draft.subjects.length) paper.subjects = draft.subjects;
  return paper;
}

function applyField(draft, field) {
  if (field.key === "authors") draft.authors = parseAuthors(field.value);
  else if (field.key === "doi") draft.doi = parseDoi(field.value);
  else if (field.key === "abstract") draft.abstract = field.value.trim();
  else if (field.key === "subjects") draft.subjects = parseSubjects(field.value);
}

/**
 * Parse a category Markdown feed into Paper[] plus lastUpdated.
 * Journal feeds: '# Category', '## Journal', '### Title', then Authors/DOI/Abstract.
 * Working papers: '## Title' per paper, plus optional Subjects. Labels may be bolded.
 */
function parseFeed(markdown, category) {
  const lastUpdated = parseLastUpdated(markdown);
  const papers = [];
  const isWorking = category === "working_papers";
  let journal = null;
  let current = null;

  const flush = () => {
    const paper = finishPaper(current, category, isWorking ? undefined : journal);
    if (paper) papers.push(paper);
    current = null;
  };

  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    if (/^#\s+/.test(line) && !/^#{2,}/.test(line)) continue;
    if (/^##\s+/.test(line)) {
      flush();
      const heading = line.replace(/^##\s+/, "").trim();
      if (isWorking) {
        current = { title: heading };
        journal = null;
      } else {
        journal = heading;
      }
      continue;
    }
    if (/^###\s+/.test(line)) {
      flush();
      current = { title: line.replace(/^###\s+/, "").trim() };
      continue;
    }
    if (/^---\s*$/.test(line)) {
      flush();
      continue;
    }
    const field = parseLabeledLine(line);
    if (field && current) {
      applyField(current, field);
      continue;
    }
    // Continuation lines for an abstract already started.
    if (current && current.abstract && line.trim() && !/^#{1,3}\s/.test(line)) {
      current.abstract = `${current.abstract} ${line.trim()}`;
    }
  }
  flush();
  return { lastUpdated, papers };
}

function parseIndex(markdown) {
  const lastUpdated = parseLastUpdated(markdown);
  const categories = [];
  const re =
    /^-\s+(.+?):\s*https?:\/\/(?:www\.)?paper-picnic\.com\/md\/([a-z0-9_]+)\.md\s*$/gim;
  let match;
  while ((match = re.exec(markdown))) {
    categories.push({
      slug: match[2],
      name: match[1].trim(),
      lastUpdated,
    });
  }
  return { lastUpdated, categories };
}

async function loadIndex() {
  return cached("index", async () => parseIndex(await fetchText(INDEX_URL)));
}

async function loadFeed(slug) {
  return cached(`feed:${slug}`, async () => {
    const markdown = await fetchText(
      `https://www.paper-picnic.com/md/${encodeURIComponent(slug)}.md`
    );
    return parseFeed(markdown, slug);
  });
}

async function requireCategory(slug) {
  const { categories } = await loadIndex();
  const found = categories.find((c) => c.slug === slug);
  if (!found) {
    const valid = categories.map((c) => c.slug).join(", ");
    const error = new Error(
      `Unknown category "${slug}". Valid slugs: ${valid || "(none listed in index)"}`
    );
    error.code = "unknown_category";
    throw error;
  }
  return found;
}

function applyLimit(items, limit) {
  const n =
    limit === undefined || limit === null || Number.isNaN(Number(limit))
      ? DEFAULT_LIMIT
      : Math.max(0, Math.floor(Number(limit)));
  return items.slice(0, n);
}

function haystack(paper) {
  const parts = [
    paper.title,
    paper.abstract,
    paper.journal,
    ...(paper.authors || []),
    ...(paper.subjects || []),
  ];
  return parts.filter(Boolean).join("\n").toLowerCase();
}

const TOOLS = [
  {
    name: "list_categories",
    description:
      "List Paper Picnic category feeds (slug, name, lastUpdated) from the public AI index. Feeds refresh every Friday at 02:00 UTC.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_papers",
    description:
      "Fetch this week's papers for one category slug (e.g. political_science, economics, working_papers). Optionally filter by journal name substring. Returns Paper[] plus feed-level lastUpdated. Default limit is 20.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Category slug from list_categories (e.g. political_science, economics, sociology, working_papers).",
        },
        journal: {
          type: "string",
          description:
            "Optional case-insensitive substring filter on the journal name.",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: "Maximum number of papers to return (default 20).",
        },
      },
      required: ["category"],
      additionalProperties: false,
    },
  },
  {
    name: "search_papers",
    description:
      "Case-insensitive search over title, abstract, authors, journal, and subjects. Defaults to all categories. Returns Paper[] plus lastUpdatedByCategory. Default limit is 20.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search string matched case-insensitively.",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional category slugs to search. Defaults to all categories from the index.",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: "Maximum number of papers to return (default 20).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

async function callListCategories() {
  const { lastUpdated, categories } = await loadIndex();
  return { lastUpdated, categories };
}

async function callGetPapers(args) {
  const category = args && args.category;
  if (!category || typeof category !== "string") {
    throw Object.assign(new Error("Missing required argument: category"), {
      code: "invalid_params",
    });
  }
  await requireCategory(category);
  const feed = await loadFeed(category);
  let papers = feed.papers;
  if (args.journal) {
    const needle = String(args.journal).toLowerCase();
    papers = papers.filter(
      (p) => p.journal && p.journal.toLowerCase().includes(needle)
    );
  }
  return {
    category,
    lastUpdated: feed.lastUpdated,
    papers: applyLimit(papers, args.limit),
  };
}

async function callSearchPapers(args) {
  const query = args && args.query;
  if (!query || typeof query !== "string" || !query.trim()) {
    throw Object.assign(new Error("Missing required argument: query"), {
      code: "invalid_params",
    });
  }
  const index = await loadIndex();
  let slugs;
  if (args.categories === undefined || args.categories === null) {
    slugs = index.categories.map((c) => c.slug);
  } else if (!Array.isArray(args.categories)) {
    throw Object.assign(new Error("categories must be an array of slugs"), {
      code: "invalid_params",
    });
  } else {
    slugs = args.categories.map(String);
    for (const slug of slugs) await requireCategory(slug);
  }
  const needle = query.trim().toLowerCase();
  const lastUpdatedByCategory = {};
  const matches = [];
  const feeds = await Promise.all(
    slugs.map(async (slug) => {
      const feed = await loadFeed(slug);
      return { slug, feed };
    })
  );
  for (const { slug, feed } of feeds) {
    lastUpdatedByCategory[slug] = feed.lastUpdated;
    for (const paper of feed.papers) {
      if (haystack(paper).includes(needle)) matches.push(paper);
    }
  }
  return {
    query: query.trim(),
    lastUpdatedByCategory,
    papers: applyLimit(matches, args.limit),
  };
}

const TOOL_HANDLERS = {
  list_categories: callListCategories,
  get_papers: callGetPapers,
  search_papers: callSearchPapers,
};

async function handleToolCall(name, args) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    const error = new Error(`Unknown tool: ${name}`);
    error.code = "unknown_tool";
    throw error;
  }
  return handler(args || {});
}

function toolResult(id, payload) {
  success(id, {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  });
}

function toolError(id, err) {
  success(id, {
    content: [{ type: "text", text: err && err.message ? err.message : String(err) }],
    isError: true,
  });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.has(requested)
      ? requested
      : DEFAULT_PROTOCOL;
    success(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === "ping") {
    success(id, {});
    return;
  }
  if (method === "tools/list") {
    success(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && (params.arguments || params.args)) || {};
    if (!name) {
      rpcError(id, -32602, "Invalid params: missing tool name");
      return;
    }
    try {
      const payload = await handleToolCall(name, args);
      toolResult(id, payload);
    } catch (err) {
      const expected = err && (err.code === "unknown_category" || err.code === "invalid_params" || err.code === "unknown_tool");
      if (!expected) log("tools/call error:", err && err.stack ? err.stack : err);
      toolError(id, err);
    }
    return;
  }
  if (method === "shutdown") {
    success(id, {});
    return;
  }
  rpcError(id, -32601, `Method not found: ${method}`);
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") {
    rpcError(msg && "id" in msg ? msg.id : null, -32600, "Invalid Request");
    return;
  }
  if (msg.method && (msg.id === undefined || msg.id === null)) {
    // Notifications: no response.
    if (
      msg.method === "notifications/initialized" ||
      msg.method === "initialized" ||
      msg.method === "notifications/cancelled"
    ) {
      return;
    }
    return;
  }
  if (!msg.method) return;
  try {
    await handleRequest(msg);
  } catch (err) {
    log("request error:", err && err.stack ? err.stack : err);
    rpcError(msg.id, -32603, err && err.message ? err.message : "Internal error");
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      rpcError(null, -32700, "Parse error");
      continue;
    }
    await handleMessage(msg);
  }
}

main().catch((err) => {
  log("fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});
