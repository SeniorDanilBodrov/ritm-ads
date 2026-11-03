"""Read-only Python analyst. Financial actions are never executed by this process.

Protocol: one JSON document on stdin, one validated JSON document on stdout.
No third-party Python packages. Optional Ollama runs on loopback only.
"""
import json
import os
import sys
import urllib.request
from urllib.parse import urlparse

VERSION = "advisor/1.0"
ACTIONS = ("observe", "review_pause", "test_message", "consider_scale")
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "proposals": {
            "type": "array",
            "maxItems": 8,
            "items": {
                "type": "object", "additionalProperties": False,
                "properties": {
                    "campaignId": {"type": "string"},
                    "action": {"type": "string", "enum": list(ACTIONS)},
                    "summary": {"type": "string", "maxLength": 400},
                },
                "required": ["campaignId", "action", "summary"],
            },
        }
    },
    "required": ["proposals"],
}


def require_snapshot(snapshot):
    if not isinstance(snapshot, dict) or type(snapshot.get("targetCpa")) is not int or snapshot["targetCpa"] <= 0:
        raise ValueError("Invalid targetCpa")
    campaigns = snapshot.get("campaigns")
    if not isinstance(campaigns, list) or len(campaigns) > 1000:
        raise ValueError("Invalid campaigns")
    seen = set()
    for c in campaigns:
        if not isinstance(c, dict) or not isinstance(c.get("id"), str) or c["id"] in seen:
            raise ValueError("Invalid campaign identity")
        seen.add(c["id"])
        for metric in ("spent", "leads", "clicks"):
            if type(c.get(metric)) is not int or c[metric] < 0:
                raise ValueError("Invalid metric")
        if c["leads"] > c["clicks"]:
            raise ValueError("Leads exceed clicks")
        if c.get("status") not in ("active", "paused"):
            raise ValueError("Invalid campaign status")
    return snapshot


def permitted_action(c, target):
    """Model suggestions are constrained by observed data, not its own confidence."""
    if c["status"] == "paused" or c["clicks"] < 100 or c["spent"] < target * 3:
        return "observe"
    cpa = c["spent"] / c["leads"] if c["leads"] else float("inf")
    if cpa > target * 1.5:
        return "review_pause"
    if c["leads"] >= 10 and cpa < target * .8:
        return "consider_scale"
    if cpa >= target * .85:
        return "test_message"
    return "observe"


SUMMARIES = {
    "observe": "Сохранить настройки и собрать больше сопоставимых данных.",
    "review_pause": "Проверить качество обращений и рассмотреть остановку этого направления.",
    "consider_scale": "Рассмотреть перенос свободного лимита сюда без увеличения общего бюджета.",
    "test_message": "Проверить другой заголовок, сохранив контрольный вариант и одинаковые условия.",
}


def validate_output(output, snapshot):
    if not isinstance(output, dict) or set(output) != {"proposals"}:
        raise ValueError("Unexpected output fields")
    proposals = output["proposals"]
    if not isinstance(proposals, list) or len(proposals) > 8:
        raise ValueError("Too many proposals")
    known = {c["id"]: c for c in snapshot["campaigns"]}
    seen = set()
    verified = []
    for p in proposals:
        if not isinstance(p, dict) or set(p) != {"campaignId", "action", "summary"}:
            raise ValueError("Unexpected proposal fields")
        if p["campaignId"] not in known or p["campaignId"] in seen:
            raise ValueError("Unknown or repeated campaign")
        seen.add(p["campaignId"])
        c = known[p["campaignId"]]
        allowed = permitted_action(c, snapshot["targetCpa"])
        if p["action"] not in ACTIONS or p["action"] not in ("observe", allowed):
            raise ValueError("Action unsupported by evidence")
        if not isinstance(p["summary"], str) or not 1 <= len(p["summary"]) <= 400:
            raise ValueError("Invalid explanation")
        # Evidence is attached by trusted code, not copied from model text.
        verified.append({**p, "evidence": {"spent": c["spent"], "leads": c["leads"], "clicks": c["clicks"], "targetCpa": snapshot["targetCpa"]}, "requiresReview": True})
    return verified


def analyze(snapshot, provider="rules", fetch_model=None):
    snapshot = require_snapshot(snapshot)
    if provider == "rules":
        output = {"proposals": [{"campaignId": c["id"], "action": permitted_action(c, snapshot["targetCpa"]), "summary": SUMMARIES[permitted_action(c, snapshot["targetCpa"])]} for c in snapshot["campaigns"][:8]]}
    elif provider == "ollama":
        output = (fetch_model or ollama)(snapshot)
    else:
        raise ValueError("Unsupported provider")
    return {"provider": provider, "version": VERSION, "proposals": validate_output(output, snapshot), "executed": False}


def analyze_with_fallback(snapshot, provider="rules", fetch_model=None):
    """Keep the read-only worker available when an optional model reply is invalid.

    The deterministic rules pass through the same evidence validator and still
    never executes an advertising action. Invalid input is not hidden: it fails
    again while building the rules result.
    """
    try:
        return analyze(snapshot, provider, fetch_model)
    except Exception:
        if provider != "ollama":
            raise
        result = analyze(snapshot, "rules")
        result["fallback"] = True
        return result


def ollama(snapshot):
    base = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
    url = urlparse(base)
    if url.scheme not in ("http", "https") or url.hostname not in ("127.0.0.1", "localhost", "::1") or url.username or url.password:
        raise ValueError("Only local Ollama endpoints are allowed")
    model = os.environ.get("OLLAMA_MODEL")
    if not model:
        raise ValueError("OLLAMA_MODEL is required")
    # Only numeric metrics and IDs are supplied. User descriptions, tokens,
    # names and website contents are deliberately absent from the context.
    features = {"targetCpa": snapshot["targetCpa"], "campaigns": [{**{k: c[k] for k in ("id", "spent", "leads", "clicks", "status")}, "allowedAction": permitted_action(c, snapshot["targetCpa"])} for c in snapshot["campaigns"][:8]]}
    prompt = "Ты аналитик рекламы. Верни JSON с короткими предложениями на русском языке. Для каждого campaignId выбирай только allowedAction или observe. Не обещай продажи. Не выдумывай факты. Рекомендации не исполняются. Используй схему. Все суммы в копейках."
    body = json.dumps({"model": model, "stream": False, "format": SCHEMA, "options": {"temperature": 0}, "messages": [{"role": "system", "content": prompt}, {"role": "user", "content": json.dumps(features, ensure_ascii=False)}]}).encode("utf-8")
    req = urllib.request.Request(base.rstrip("/") + "/api/chat", data=body, headers={"Content-Type": "application/json"}, method="POST")
    # Do not follow a local endpoint redirect to a remote host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    with opener.open(req, timeout=35) as response:
        raw = response.read(100001)
        if len(raw) > 100000:
            raise ValueError("Response too large")
        result = json.loads(raw)
    return json.loads(result["message"]["content"])


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(1000001)
        if len(raw) > 1000000:
            raise ValueError("Input too large")
        result = analyze_with_fallback(
            json.loads(raw), os.environ.get("AI_PROVIDER", "rules")
        )
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    except Exception as error:
        # No raw provider responses, tokens or environment values in errors.
        sys.stderr.write(type(error).__name__ + ": analyst failed validation or execution\n")
        sys.exit(1)
