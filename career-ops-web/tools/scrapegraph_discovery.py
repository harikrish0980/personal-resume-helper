#!/usr/bin/env python
"""Local ScrapeGraphAI sidecar for EaZy Job Apply discovery.

Reads JSON from stdin and writes one JSON object to stdout. The Node app owns
URL safety, scoring, dedupe, and persistence; this sidecar only extracts
possible job records from approved company/career pages.
"""

from __future__ import annotations

import json
import os
import re
import ipaddress
import sys
from typing import Any
from urllib.parse import urlparse


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"Invalid sidecar input: {exc}"}))
        return 0

    if payload.get("mock"):
        print(json.dumps(mock_response(payload)))
        return 0

    try:
        from scrapegraphai.graphs import SmartScraperGraph  # type: ignore
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": f"Local AI Scraper is not installed or not importable: {exc}",
            "providerTrace": [{"step": "import_scrapegraphai", "status": "failed"}],
        }))
        return 0

    query = clean_text(payload.get("query") or "data engineer")
    location = clean_text(payload.get("location") or "")
    seed_urls = [url for url in payload.get("seedUrls") or [] if is_safe_https_url(url)]
    max_jobs = max(1, min(50, int(payload.get("maxJobs") or 15)))
    llm_model = payload.get("llmModel") or os.getenv("SCRAPEGRAPH_LLM") or "ollama/llama3.2:1b"
    ollama_base_url = payload.get("ollamaBaseUrl") or os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434"
    jobs: list[dict[str, Any]] = []
    trace: list[dict[str, Any]] = []

    for seed_url in seed_urls:
        if len(jobs) >= max_jobs:
            break
        prompt = (
            "Extract current job postings from this approved company careers page. "
            f"Target role/search: {query}. Target location preference: {location or 'any'}. "
            "Return only JSON with a top-level jobs array. Each job must include: "
            "title, company, location, remoteType, employmentType, postedAt, jobUrl, "
            "applyUrl, description, salary, skills, extractionConfidence, "
            "extractionWarnings, sourceEvidence. Use null or empty strings when unknown. "
            "Do not invent salary, sponsorship, or remote status."
        )
        config = {
            "llm": {
                "model": llm_model,
                "base_url": ollama_base_url,
            },
            "verbose": False,
            "headless": True,
        }
        try:
            graph = SmartScraperGraph(prompt=prompt, source=seed_url, config=config)
            raw_result = graph.run()
            extracted = normalize_result(raw_result, seed_url, max_jobs - len(jobs))
            jobs.extend(extracted)
            trace.append({"step": "scrapegraph_local", "status": "completed", "url": seed_url, "count": len(extracted)})
        except Exception as exc:
            trace.append({"step": "scrapegraph_local", "status": "failed", "url": seed_url, "error": public_error(str(exc))})

    print(json.dumps({
        "ok": True,
        "jobs": jobs[:max_jobs],
        "providerTrace": trace,
        "diagnostics": {
            "model": llm_model,
            "ollamaBaseUrl": ollama_base_url,
            "seedCount": len(seed_urls),
        },
    }))
    return 0


def normalize_result(raw_result: Any, seed_url: str, limit: int) -> list[dict[str, Any]]:
    data = raw_result
    if isinstance(data, str):
        data = parse_jsonish(data)
    if isinstance(data, dict):
        candidates = data.get("jobs") or data.get("job_postings") or data.get("results") or []
    elif isinstance(data, list):
        candidates = data
    else:
        candidates = []

    jobs: list[dict[str, Any]] = []
    for item in candidates[:limit]:
        if not isinstance(item, dict):
            continue
        title = clean_text(item.get("title") or item.get("role") or "")
        apply_url = clean_text(item.get("applyUrl") or item.get("apply_url") or item.get("jobUrl") or item.get("url") or "")
        job_url = clean_text(item.get("jobUrl") or item.get("job_url") or apply_url or seed_url)
        if not title or not is_safe_https_url(job_url):
            continue
        if apply_url and not is_safe_https_url(apply_url):
            apply_url = job_url
        confidence = item.get("extractionConfidence", item.get("confidence", 65))
        jobs.append({
            "externalId": clean_text(item.get("externalId") or item.get("id") or apply_url or job_url),
            "title": title[:160],
            "company": clean_text(item.get("company") or "")[:120],
            "location": clean_text(item.get("location") or "")[:160],
            "remoteType": clean_text(item.get("remoteType") or item.get("remote_type") or "")[:80],
            "employmentType": clean_text(item.get("employmentType") or item.get("employment_type") or "")[:80],
            "postedAt": clean_text(item.get("postedAt") or item.get("posted_at") or item.get("date") or "")[:80],
            "jobUrl": job_url,
            "applyUrl": apply_url or job_url,
            "description": clean_text(item.get("description") or item.get("summary") or "")[:12000],
            "salary": clean_text(item.get("salary") or "")[:120],
            "skills": normalize_skills(item.get("skills")),
            "extractionConfidence": normalize_confidence(confidence),
            "extractionWarnings": normalize_warnings(item.get("extractionWarnings") or item.get("warnings")),
            "sourceEvidence": clean_text(item.get("sourceEvidence") or item.get("evidence") or "")[:1000],
            "seedUrl": seed_url,
        })
    return jobs


def mock_response(payload: dict[str, Any]) -> dict[str, Any]:
    seed = (payload.get("seedUrls") or ["https://example.com/careers"])[0]
    query = clean_text(payload.get("query") or "Senior Data Engineer")
    return {
        "ok": True,
        "jobs": [{
            "externalId": f"mock-{slug(query)}",
            "title": query.title(),
            "company": "Local AI Mock Company",
            "location": clean_text(payload.get("location") or "United States"),
            "remoteType": "Hybrid",
            "employmentType": "Full-time",
            "postedAt": "",
            "jobUrl": seed,
            "applyUrl": seed,
            "description": f"Mock local AI extracted job for {query} with SQL, Python, Databricks, Spark, Snowflake, Azure, and ETL pipelines.",
            "salary": "",
            "skills": ["SQL", "Python", "Databricks", "Spark", "Snowflake", "Azure", "ETL"],
            "extractionConfidence": 82,
            "extractionWarnings": ["Mock fixture result"],
            "sourceEvidence": "Generated by SCRAPEGRAPH_MOCK=1",
            "seedUrl": seed,
        }],
        "providerTrace": [{"step": "scrapegraph_local_mock", "status": "completed", "count": 1}],
        "diagnostics": {"mock": True},
    }


def parse_jsonish(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        match = re.search(r"(\{.*\}|\[.*\])", value, re.S)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                return {}
    return {}


def is_safe_https_url(value: str) -> bool:
    try:
        parsed = urlparse(str(value).strip())
    except Exception:
        return False
    if parsed.scheme != "https" or not parsed.netloc:
        return False
    host = parsed.hostname or ""
    blocked_hosts = {"localhost", "0.0.0.0", "127.0.0.1", "::1", "169.254.169.254"}
    if host.lower() in blocked_hosts or host.lower().endswith(".localhost"):
        return False
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    except ValueError:
        pass
    blocked_domains = ("linkedin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com", "monster.com", "dice.com")
    return not any(host.lower() == domain or host.lower().endswith("." + domain) for domain in blocked_domains)


def normalize_skills(value: Any) -> list[str]:
    if isinstance(value, list):
        return [clean_text(item) for item in value if clean_text(item)][:16]
    if isinstance(value, str):
        return [clean_text(item) for item in re.split(r"[,|;/]", value) if clean_text(item)][:16]
    return []


def normalize_warnings(value: Any) -> list[str]:
    if isinstance(value, list):
        return [clean_text(item) for item in value if clean_text(item)][:8]
    if isinstance(value, str) and value.strip():
        return [clean_text(value)[:240]]
    return []


def normalize_confidence(value: Any) -> int:
    try:
        number = float(value)
    except Exception:
        return 65
    if number <= 1:
        number *= 100
    return int(max(0, min(100, round(number))))


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:80]


def public_error(value: str) -> str:
    return re.sub(r"[A-Z]:\\[^ \"'\n\r]+", "<local path>", clean_text(value))[:260]


if __name__ == "__main__":
    raise SystemExit(main())
