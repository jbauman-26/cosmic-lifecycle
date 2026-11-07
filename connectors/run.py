"""Cosmic Lifecycle warehouse runner.

The Node CLI starts this with `uv run` and passes one JSON job on stdin.
Secrets arrive as LIFECYCLE_SRC_SECRET_<NAME> environment variables, never
on the command line, and are scrubbed from any error text before it is printed.

Actions:
  check   fetch one page of the first resource, to prove the key works
  sync    load every resource into the warehouse with dlt
  query   run one read-only SQL query against a local DuckDB warehouse
  schema  list tables and columns of a local DuckDB warehouse

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

# Personal data is removed by key name before anything is written. A key is
# split into words (snake_case, camelCase, kebab-case), and removed when its
# words name a person or a way to reach one.
ALWAYS_PERSONAL = {
    "email", "phone", "mobile", "telephone", "fax", "firstname", "lastname", "fullname",
    "surname", "address", "address1", "address2", "street", "zip", "zipcode", "postcode",
    "postal", "birthday", "birthdate", "dob", "ssn", "ip", "ipaddress", "latitude", "longitude",
    "password", "token", "secret",
}
NAME_OWNERS = {
    "first", "last", "full", "middle", "customer", "billing", "shipping", "contact", "recipient",
    "sender", "author", "reviewer", "buyer", "user", "display", "person", "profile", "subscriber",
    "member", "owner", "assignee", "requester", "agent",
}
EMAIL_VALUE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def words(key: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key)
    return [w for w in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if w]


def is_personal(key: str) -> bool:
    ws = words(key)
    joined = "".join(ws)
    if joined in ALWAYS_PERSONAL or any(w in ALWAYS_PERSONAL for w in ws):
        return True
    return "name" in ws and any(w in NAME_OWNERS for w in ws)


def strip_personal(item: Any) -> Any:
    if isinstance(item, dict):
        return {k: strip_personal(v) for k, v in item.items() if not is_personal(str(k))}
    if isinstance(item, list):
        return [strip_personal(v) for v in item]
    if isinstance(item, str) and EMAIL_VALUE.search(item):
        return EMAIL_VALUE.sub("[removed]", item)
    return item


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


def build_source(job: dict[str, Any]):
    from dlt.sources.rest_api import rest_api_source

    config = fill(job["source"]["config"], job.get("params", {}))
    source = rest_api_source(config, name=job["source"]["slug"].replace("-", "_"))
    if job.get("personal_data", "strip") == "strip":
        for resource in source.resources.values():
            resource.add_map(strip_personal)
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
        # dlt keeps a <dataset>_staging copy for merges, and its own _dlt columns.
        where = "table_schema NOT IN ('information_schema', 'pg_catalog', 'main') AND table_schema NOT LIKE '%\\_staging' ESCAPE '\\' AND column_name NOT LIKE '\\_dlt%' ESCAPE '\\'"
        args: list[Any] = []
        if job.get("dataset"):
            where += " AND table_schema = ?"
            args.append(job["dataset"])
        rows = con.execute(
            f"SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE {where} AND table_name NOT LIKE '_dlt%' ORDER BY 1, 2, ordinal_position",
            args,
        ).fetchall()
        return {"columns": [{"schema": r[0], "table": r[1], "column": r[2], "type": r[3]} for r in rows]}
    finally:
        con.close()


def action_validate(job: dict[str, Any]) -> dict[str, Any]:
    """Build the dlt source from a config without calling the API, using dummy secrets."""
    import re as _re

    text = json.dumps(job["source"]["config"])
    for name in set(_re.findall(r"\{secret:([A-Za-z0-9_]+)\}", text)):
        os.environ.setdefault(SECRET_PREFIX + name.upper(), "validate-only")
    params = {n: "example" for n in set(_re.findall(r"\{param:([A-Za-z0-9_]+)\}", text))}
    source = build_source({**job, "params": {**params, **job.get("params", {})}})
    return {"resources": list(source.resources.keys())}


ACTIONS = {"validate": action_validate, "check": action_check, "sync": action_sync, "query": action_query, "schema": action_schema}


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
