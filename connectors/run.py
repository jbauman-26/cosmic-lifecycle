"""Cosmic Lifecycle warehouse runner.

The Node CLI starts this with `uv run` and passes one JSON job on stdin.
Secrets arrive as LIFECYCLE_SRC_SECRET_<NAME> environment variables, never
on the command line, and are scrubbed from any error text before it is printed.

Actions:
  check   fetch one page of the first resource, to prove the key works
  sync    load every resource into the warehouse with dlt
  query   run one read-only SQL query against a local DuckDB warehouse
  schema  list tables and columns of a local DuckDB warehouse
  scrub   null or rewrite columns of a local DuckDB warehouse, and count the rows

The last line of stdout is always one JSON object: {"ok": true, ...} or
{"ok": false, "error": "..."}.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime
from decimal import Decimal
from typing import Any

SECRET_PREFIX = "LIFECYCLE_SRC_SECRET_"
PLACEHOLDER = re.compile(r"\{(secret|param):([A-Za-z0-9_]+)\}")

# Personal data is removed before anything is written. The rule list is not kept here: it lives in
# the CLI (src/personal.ts), which sends it with every job and writes it to personal-rules.json beside
# this file. This file holds only the algorithm that applies it. No rules, no load: a sync or check
# that asks for personal data to be removed stops instead of loading unfiltered rows.
RULES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "personal-rules.json")
EMAIL_VALUE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_VALUE = re.compile(r"(?<![\w+])(?:\+(?=(?:[ .()-]*\d){8})\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){1,4}[ .-]?\d{3,4}|\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4})(?!\d)", re.ASCII)
REMOVED = "[removed]"


class Rules:
    """The rule list from src/personal.ts, as sets. See that file for what each rule means."""

    def __init__(self, data: dict[str, Any]):
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("The personal data rules are missing or from another version. Reinstall Cosmic Lifecycle.")
        g = lambda k: frozenset(data[k])  # noqa: E731
        self.always, self.name_owners, self.person_words, self.person_keys = g("always"), g("nameOwners"), g("personWords"), g("personKeys")
        self.people_tables, self.authored_tables = g("peopleTables"), g("authoredTables")
        self.in_person_words, self.in_person_keys, self.person_scalars = g("inPersonWords"), g("inPersonKeys"), g("personScalars")
        self.authored_keys, self.authored_free_text, self.region = g("authoredKeys"), g("authoredFreeText"), g("region")
        self.free_text_words, self.free_text_tails, self.store_tables = g("freeTextWords"), g("freeTextTails"), g("storeTables")
        self.free_text_containers = g("freeTextContainers")
        self.store_prefixes = tuple(data["storePrefixes"])
        self.sources = data.get("sources") or {}


_RULES: Rules | None = None


def rules(job: dict[str, Any] | None = None) -> Rules:
    """The rules from the job when it carries them, else from the file beside this one."""
    global _RULES
    if job is not None and job.get("rules"):
        _RULES = Rules(job["rules"])
    if _RULES is None:
        try:
            with open(RULES_FILE, encoding="utf-8") as f:
                _RULES = Rules(json.load(f))
        except OSError:
            raise ValueError("The personal data rules are missing from this install, so nothing was loaded. Reinstall Cosmic Lifecycle.") from None
    return _RULES


def words(key: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key)
    return [w for w in re.split(r"[^a-z0-9]+", spaced.lower()) if w]


def norm(key: str) -> str:
    return "".join(words(key))


def has(listed: frozenset[str], w: str) -> bool:
    return w in listed or (w.endswith("s") and w[:-1] in listed) or (w.endswith("es") and w[:-2] in listed)


def is_personal(key: str) -> bool:
    r, ws = rules(), words(key)
    if has(r.always, "".join(ws)) or any(has(r.always, w) for w in ws):
        return True
    return "name" in ws and any(w in r.name_owners for w in ws)


def owns_person(key: str) -> bool:
    r = rules()
    return has(r.person_keys, norm(key)) or any(has(r.person_words, w) for w in words(key))


def in_person_key(key: str) -> bool:
    r = rules()
    if norm(key) in r.region:
        return False
    return norm(key) in r.in_person_keys or any(has(r.in_person_words, w) for w in words(key))


def person_scalar_key(key: str) -> bool:
    return has(rules().person_scalars, norm(key))


def free_text_key(key: str) -> bool:
    r, ws = rules(), words(key)
    if not ws:
        return False
    return ws[-1] in r.free_text_words or (ws[-1] in r.free_text_tails and any(w in r.free_text_words for w in ws))


def last_word(table: str) -> str:
    ws = words(table.split("__")[0])
    return ws[-1] if ws else ""


def is_people_table(table: str) -> bool:
    return has(rules().people_tables, last_word(table))


def is_authored_table(table: str) -> bool:
    return has(rules().authored_tables, last_word(table))


def is_store_table(table: str) -> bool:
    r, root = rules(), table.split("__")[0].lower()
    return root.startswith(r.store_prefixes) or has(r.store_tables, norm(root))


def overrides_for(source: str | None, table: str) -> dict[str, str]:
    mine = ((rules().sources.get(source or "") or {}).get(table.split("__")[0])) or {}
    return {"__".join(norm(p) for p in path.split("__")): v for path, v in mine.items()}


def free_text_container(key: str) -> bool:
    r = rules()
    return any(w in r.free_text_containers for w in words(key))


def textish(v: Any) -> bool:
    """Text, or a list of text: what a name or a comment is stored as. A number under `author` is an id."""
    return isinstance(v, str) or (isinstance(v, list) and len(v) > 0 and all(isinstance(x, str) for x in v))


# A value that is nothing but a phone number written with its country code. An id never starts with +.
WHOLE_PHONE = re.compile(r"\s*\+\d[\d ().-]{6,}\d\s*", re.ASCII)


def scrub_emails(text: str) -> str:
    return REMOVED if WHOLE_PHONE.fullmatch(text) else EMAIL_VALUE.sub(REMOVED, text)


def scrub_free_text(text: str) -> str:
    return PHONE_VALUE.sub(REMOVED, EMAIL_VALUE.sub(REMOVED, text))


class Walk:
    """One table's settings for a walk over its rows."""

    def __init__(self, extra: frozenset[str] = frozenset(), source: str | None = None, table: str = "", free_text: str = "keep"):
        self.extra = extra
        self.drop_text = free_text == "drop"
        self.people = is_people_table(table) if table else False
        self.authored = is_authored_table(table) if table else False
        self.store = is_store_table(table) if table else False
        self.overrides = overrides_for(source, table) if table else {}

    def run(self, item: Any, in_person: bool | None = None) -> Any:
        return self.walk(item, (), self.people if in_person is None else in_person, False)

    def walk(self, item: Any, path: tuple[str, ...], in_person: bool, free: bool) -> Any:
        """`free` is set inside free text: there, phone numbers go from every string as well as emails."""
        if isinstance(item, dict):
            out = {}
            for k, v in item.items():
                key = str(k)
                here = path + (norm(key),)
                if key in self.extra:
                    continue
                o = self.overrides.get("__".join(here))
                if o == "personal":
                    continue
                inside = free
                if o == "free_text":
                    inside = True
                elif o != "keep":
                    if is_personal(key) or (in_person and in_person_key(key)):
                        continue
                    top = len(here) == 1
                    if textish(v) and (person_scalar_key(key) or (self.authored and top and norm(key) in rules().authored_keys)):
                        continue
                    if not self.store and free_text_container(key):
                        inside = True
                    elif textish(v) and not self.store and (free_text_key(key) or (self.authored and top and norm(key) in rules().authored_free_text)):
                        inside = True
                if inside and not free and self.drop_text:
                    continue
                out[k] = self.walk(v, here, in_person or owns_person(key), inside)
            return out
        if isinstance(item, list):
            return [self.walk(v, path, in_person, free) for v in item]
        if isinstance(item, str):
            return scrub_free_text(item) if free else scrub_emails(item)
        return item


def strip_personal(item: Any, extra: frozenset[str] = frozenset(), in_person: bool = False, source: str | None = None, table: str = "", free_text: str = "keep") -> Any:
    """Remove personal data from one row. `extra` holds exact key names a spec lists under strip_fields."""
    w = Walk(extra, source, table, free_text)
    return w.run(item, True if in_person else None)


def secret_values() -> list[str]:
    return [v for k, v in os.environ.items() if k.startswith(SECRET_PREFIX) and v]


def scrub(text: str) -> str:
    for value in secret_values():
        text = text.replace(value, "[secret]")
    return text


def fill(value: Any, params: dict[str, str]) -> Any:
    """Replace {secret:NAME} and {param:NAME} placeholders anywhere in the config."""
    if isinstance(value, dict):
        return {k: fill(v, params) for k, v in value.items()}
    if isinstance(value, list):
        return [fill(v, params) for v in value]
    if isinstance(value, str):
        def sub(m: re.Match[str]) -> str:
            kind, name = m.group(1), m.group(2)
            if kind == "secret":
                found = os.environ.get(SECRET_PREFIX + name.upper())
                if not found:
                    raise ValueError(f"Missing secret {name}. Connect the source again.")
                return found
            if name not in params:
                raise ValueError(f"Missing setting {name}. Connect the source again with it.")
            return params[name]
        return PLACEHOLDER.sub(sub, value)
    return value


def from_base_paginator(next_url_path: str, base_url: str):
    """json_link_from_base: a next link that is relative to the API's base path, not the host root.

    dlt's json_link joins a relative link against the host, which drops a base path
    such as /enterprise. This one joins it to the client's base_url instead.
    """
    from dlt.sources.helpers.rest_client.paginators import JSONLinkPaginator

    class JSONLinkFromBasePaginator(JSONLinkPaginator):
        def update_state(self, response: Any, data: Any = None) -> None:
            super().update_state(response, data)
            ref = self._next_reference
            if ref and not str(ref).startswith("http"):
                self._next_reference = base_url.rstrip("/") + "/" + str(ref).lstrip("/")

    return JSONLinkFromBasePaginator(next_url_path=next_url_path)


def custom_paginators(value: Any, base_url: str) -> Any:
    """Swap {"type": "json_link_from_base", "next_url_path": ...} for a paginator object, anywhere in the config."""
    if isinstance(value, dict):
        if value.get("type") == "json_link_from_base":
            return from_base_paginator(value.get("next_url_path", "next"), base_url)
        return {k: custom_paginators(v, base_url) for k, v in value.items()}
    if isinstance(value, list):
        return [custom_paginators(v, base_url) for v in value]
    return value


def build_source(job: dict[str, Any]):
    from dlt.sources.rest_api import rest_api_source

    config = fill(job["source"]["config"], job.get("params", {}))
    config = custom_paginators(config, str((config.get("client") or {}).get("base_url", "")))
    source = rest_api_source(config, name=job["source"]["slug"].replace("-", "_"))
    if job.get("personal_data", "strip") == "strip":
        rules(job)
        extra = frozenset(job["source"].get("strip_fields") or [])
        mode = "drop" if job.get("free_text") == "drop" else "keep"

        def stripper(table: str):
            walk = Walk(extra, job["source"]["slug"], table, mode)
            return lambda item: walk.run(item)

        for name, resource in source.resources.items():
            table = getattr(resource, "table_name", None)
            resource.add_map(stripper(table if isinstance(table, str) and table else name))
    return source


def destination(job: dict[str, Any]):
    import dlt

    dest = job["destination"]
    if dest["kind"] == "postgres":
        url = os.environ.get(dest["url_env"])
        if not url:
            raise ValueError(f"{dest['url_env']} is empty.")
        return dlt.destinations.postgres(credentials=url)
    return dlt.destinations.duckdb(credentials=dest["path"])


def jsonable(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    return v


def action_check(job: dict[str, Any]) -> dict[str, Any]:
    source = build_source(job)
    first = next(iter(source.resources.keys()))
    resource = source.with_resources(first).resources[first].add_limit(1)
    rows = 0
    keys: set[str] = set()
    for item in resource:
        batch = item if isinstance(item, list) else [item]
        rows += len(batch)
        for row in batch:
            if isinstance(row, dict):
                keys.update(row.keys())
    return {"resource": first, "rows": rows, "fields": sorted(keys)[:40]}


def action_sync(job: dict[str, Any]) -> dict[str, Any]:
    import dlt

    source = build_source(job)
    only = job.get("resources")
    if only:
        source = source.with_resources(*only)
    pipeline = dlt.pipeline(
        pipeline_name="lifecycle_" + job["source"]["slug"].replace("-", "_"),
        destination=destination(job),
        dataset_name=job["dataset"],
        pipelines_dir=job["pipelines_dir"],
        progress="log" if job.get("verbose") else None,
    )
    info = pipeline.run(source)
    counts = {}
    trace = pipeline.last_trace
    if trace and trace.last_normalize_info:
        counts = {t: n for t, n in trace.last_normalize_info.row_counts.items() if not t.startswith("_dlt")}
    return {
        "dataset": job["dataset"],
        "tables": counts,
        "rows": sum(counts.values()),
        "loads": len(info.loads_ids),
    }


def duck(job: dict[str, Any]):
    import duckdb

    path = job["destination"]["path"]
    if not os.path.exists(path):
        raise ValueError("The warehouse is empty. Run lifecycle warehouse sync first.")
    # Read-only, and no file or network access from inside a query (read_csv, httpfs, ATTACH).
    return duckdb.connect(path, read_only=True, config={"enable_external_access": False})


def action_query(job: dict[str, Any]) -> dict[str, Any]:
    con = duck(job)
    try:
        cur = con.execute(job["sql"])
        cols = [d[0] for d in cur.description or []]
        limit = int(job.get("limit", 1000))
        rows = [dict(zip(cols, [jsonable(v) for v in r])) for r in cur.fetchmany(limit)]
        return {"columns": cols, "rows": rows}
    finally:
        con.close()


def action_schema(job: dict[str, Any]) -> dict[str, Any]:
    con = duck(job)
    try:
        where = "table_schema NOT IN ('information_schema', 'pg_catalog')"
        if not job.get("everything"):
            # dlt keeps a <dataset>_staging copy for merges, and its own _dlt columns.
            where += " AND table_schema <> 'main' AND table_schema NOT LIKE '%\\_staging' ESCAPE '\\' AND column_name NOT LIKE '\\_dlt%' ESCAPE '\\' AND table_name NOT LIKE '_dlt%'"
        args: list[Any] = []
        if job.get("dataset"):
            where += " AND table_schema = ?"
            args.append(job["dataset"])
        rows = con.execute(
            f"SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE {where} ORDER BY 1, 2, ordinal_position",
            args,
        ).fetchall()
        return {"columns": [{"schema": r[0], "table": r[1], "column": r[2], "type": r[3], "nullable": r[4] != "NO"} for r in rows]}
    finally:
        con.close()


def quote_ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def action_scrub(job: dict[str, Any]) -> dict[str, Any]:
    """Null or rewrite columns in a local DuckDB warehouse. The CLI decides which; this only counts and writes.

    Each plan entry is {schema, table, column, action}: `null` empties the column, `replace` writes a
    row-unique placeholder into a column that may not be empty, `rewrite` takes email addresses and
    phone numbers out of kept text. Counts go back, never a value.
    """
    import duckdb

    path = job["destination"]["path"]
    if not os.path.exists(path):
        raise ValueError("The warehouse is empty. Run lifecycle warehouse sync first.")
    apply = bool(job.get("apply"))
    con = duckdb.connect(path, read_only=not apply, config={"enable_external_access": False})
    try:
        out = []
        for step in job.get("plan") or []:
            target = f"{quote_ident(step['schema'])}.{quote_ident(step['table'])}"
            col = quote_ident(step["column"])
            action = step["action"]
            try:
                if action == "rewrite":
                    # Text that could hold an email address or a phone number is read here, changed in
                    # memory and written back by row. Nothing read leaves this function.
                    found = con.execute(f"SELECT rowid, CAST({col} AS VARCHAR) FROM {target} WHERE {col} IS NOT NULL AND regexp_matches(CAST({col} AS VARCHAR), '@|[0-9]{{3}}')").fetchall()
                    changed = [(scrub_free_text(text), rowid) for rowid, text in found if scrub_free_text(text) != text]
                    rows = len(changed)
                    if apply and changed:
                        con.executemany(f"UPDATE {target} SET {col} = ? WHERE rowid = ?", changed)
                else:
                    if action == "replace":
                        cond = f"{col} IS NOT NULL AND CAST({col} AS VARCHAR) NOT LIKE 'removed-%'"
                        change = f"UPDATE {target} SET {col} = 'removed-' || \"_dlt_id\" WHERE {cond}"
                    else:
                        cond = f"{col} IS NOT NULL"
                        change = f"UPDATE {target} SET {col} = NULL WHERE {cond}"
                    rows = int(con.execute(f"SELECT count(*) FROM {target} WHERE {cond}").fetchone()[0])
                    if apply and rows:
                        con.execute(change)
                out.append({**step, "rows": rows, "status": "done" if apply else "planned"})
            except Exception as e:  # noqa: BLE001 - one column that cannot be changed must not stop the rest
                out.append({**step, "rows": 0, "status": "failed", "reason": type(e).__name__})
        if apply:
            con.execute("CHECKPOINT")
    finally:
        con.close()
    rebuilt = None
    if apply and any(step.get("rows") for step in out):
        rebuilt = rebuild_duck(path)
    return {"applied": apply, "steps": out, "rebuilt": rebuilt}


def rebuild_duck(path: str) -> bool:
    """Copy the warehouse into a new file and swap it in, so the old file's bytes are gone too.

    An UPDATE leaves the old values in the file until the space is reused. The copy holds only what
    the tables hold now. It is swapped in only after every table has the same number of rows.
    """
    import duckdb

    fresh = path + ".scrub-tmp"
    for leftover in (fresh, fresh + ".wal"):
        if os.path.exists(leftover):
            os.remove(leftover)
    try:
        con = duckdb.connect(path)
        try:
            name = con.execute("SELECT current_database()").fetchone()[0]
            con.execute(f"ATTACH '{fresh.replace(chr(39), chr(39) * 2)}' AS lc_fresh")
            con.execute(f"COPY FROM DATABASE {quote_ident(name)} TO lc_fresh")
            tables = con.execute("SELECT table_schema, table_name FROM information_schema.tables WHERE table_catalog = ? AND table_type = 'BASE TABLE'", [name]).fetchall()
            for schema, table in tables:
                t = f"{quote_ident(schema)}.{quote_ident(table)}"
                old_n = con.execute(f"SELECT count(*) FROM {quote_ident(name)}.{t}").fetchone()[0]
                new_n = con.execute(f"SELECT count(*) FROM lc_fresh.{t}").fetchone()[0]
                if old_n != new_n:
                    raise ValueError("row counts differ")
            con.execute("DETACH lc_fresh")
        finally:
            con.close()
        os.replace(fresh, path)
        if os.path.exists(path + ".wal"):
            os.remove(path + ".wal")
        return True
    except Exception:  # noqa: BLE001 - the scrubbed warehouse stays in place when the copy fails
        for leftover in (fresh, fresh + ".wal"):
            if os.path.exists(leftover):
                os.remove(leftover)
        return False


def action_validate(job: dict[str, Any]) -> dict[str, Any]:
    """Build the dlt source from a config without calling the API, using dummy secrets."""
    import re as _re

    text = json.dumps(job["source"]["config"])
    for name in set(_re.findall(r"\{secret:([A-Za-z0-9_]+)\}", text)):
        os.environ.setdefault(SECRET_PREFIX + name.upper(), "validate-only")
    params = {n: "example" for n in set(_re.findall(r"\{param:([A-Za-z0-9_]+)\}", text))}
    source = build_source({**job, "params": {**params, **job.get("params", {})}})
    return {"resources": list(source.resources.keys())}


ACTIONS = {"validate": action_validate, "check": action_check, "sync": action_sync, "query": action_query, "schema": action_schema, "scrub": action_scrub}


def main() -> int:
    try:
        job = json.loads(sys.stdin.read())
        result = ACTIONS[job["action"]](job)
        print(json.dumps({"ok": True, **result}, default=jsonable))
        return 0
    except Exception as e:  # noqa: BLE001 - every failure becomes one JSON line
        message = scrub(f"{type(e).__name__}: {e}")
        print(json.dumps({"ok": False, "error": message[:2000]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
