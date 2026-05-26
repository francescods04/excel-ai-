#!/usr/bin/env python3
"""
browser-use sidecar: HTTP service that runs agentic browser tasks.

Exposes:
  POST /run   { "task": "natural language goal", "max_steps": int (default 25),
                "headless": bool, "model": "string" (optional override) }
              → { "ok": bool, "result": str, "history": [...], "screenshots": [b64...] }

  GET /health → { "ok": true, "browser_use_version": "...", "llm_model": "..." }

Default LLM: DeepSeek v4 Flash via OpenAI-compatible endpoint (cheap, capable).
Override with env: BROWSERUSE_LLM_MODEL, BROWSERUSE_LLM_BASE_URL, BROWSERUSE_LLM_API_KEY.
"""

import os
import asyncio
import base64
import logging
from typing import Optional, List
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# Load env from the parent project .env
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

LLM_MODEL = os.getenv("BROWSERUSE_LLM_MODEL", "deepseek-v4-flash")
LLM_BASE_URL = os.getenv("BROWSERUSE_LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_API_KEY = (
    os.getenv("BROWSERUSE_LLM_API_KEY")
    or os.getenv("DEEPSEEK_API_KEY")
    or os.getenv("OPENROUTER_API_KEY")
    or os.getenv("OPENAI_API_KEY")
    or ""
)

# Lazy imports so the service file is importable even before pip install completes.
_agent_cls = None
_llm = None


def _ensure_loaded():
    global _agent_cls, _llm
    if _agent_cls is not None and _llm is not None:
        return
    try:
        from browser_use.agent.service import Agent  # type: ignore
        from browser_use.llm import ChatDeepSeek, ChatOpenAI  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "Missing python deps. Run: .venv-openbb/bin/pip install browser-use"
        ) from e
    _agent_cls = Agent
    if not LLM_API_KEY:
        raise RuntimeError(
            "Missing LLM API key. Set BROWSERUSE_LLM_API_KEY or DEEPSEEK_API_KEY in .env"
        )
    # Prefer native ChatDeepSeek when base URL points to deepseek; otherwise ChatOpenAI with base_url override.
    if "deepseek" in LLM_BASE_URL.lower():
        _llm = ChatDeepSeek(model=LLM_MODEL, api_key=LLM_API_KEY)
    else:
        _llm = ChatOpenAI(model=LLM_MODEL, base_url=LLM_BASE_URL, api_key=LLM_API_KEY)


class RunRequest(BaseModel):
    task: str
    max_steps: int = 25
    headless: bool = True
    model: Optional[str] = None
    use_vision: bool = True
    return_screenshots: bool = False


class RunResponse(BaseModel):
    ok: bool
    result: Optional[str] = None
    history: List[dict] = []
    screenshots: List[str] = []
    error: Optional[str] = None
    steps: int = 0


app = FastAPI(title="browser-use sidecar", version="0.1.0")


@app.get("/health")
def health():
    try:
        _ensure_loaded()
        import browser_use as bu
        return {
            "ok": True,
            "browser_use_version": getattr(bu, "__version__", "unknown"),
            "llm_model": LLM_MODEL,
            "llm_base_url": LLM_BASE_URL,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e), "llm_model": LLM_MODEL}


@app.post("/run", response_model=RunResponse)
async def run_task(req: RunRequest):
    try:
        _ensure_loaded()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    from browser_use.agent.service import Agent  # type: ignore
    from browser_use.browser import BrowserSession, BrowserProfile  # type: ignore
    from browser_use.llm import ChatDeepSeek, ChatOpenAI  # type: ignore

    llm = _llm
    if req.model:
        if "deepseek" in LLM_BASE_URL.lower():
            llm = ChatDeepSeek(model=req.model, api_key=LLM_API_KEY)
        else:
            llm = ChatOpenAI(model=req.model, base_url=LLM_BASE_URL, api_key=LLM_API_KEY)

    profile = BrowserProfile(headless=req.headless)
    session = BrowserSession(browser_profile=profile)
    agent = Agent(
        task=req.task,
        llm=llm,
        browser_session=session,
        use_vision=req.use_vision,
        max_actions_per_step=10,
    )

    try:
        history = await agent.run(max_steps=req.max_steps)
        final = history.final_result() if hasattr(history, "final_result") else None
        # history is an AgentHistoryList; iterate steps.
        step_list = getattr(history, "history", []) or []
        steps = len(step_list)

        history_compact = []
        for h in step_list[:50]:
            entry = {}
            # Each step usually has a .state with url+title and a .model_output with actions.
            state = getattr(h, "state", None)
            if state is not None:
                entry["url"] = getattr(state, "url", None)
                entry["title"] = getattr(state, "title", None)
            else:
                entry["url"] = getattr(h, "url", None)
                entry["title"] = getattr(h, "title", None)
            mo = getattr(h, "model_output", None)
            if mo is not None:
                entry["action_summary"] = str(mo)[:400]
            history_compact.append(entry)

        screenshots = []
        if req.return_screenshots:
            shots = getattr(history, "screenshots", None) or []
            for s in shots[:6]:
                if isinstance(s, bytes):
                    screenshots.append(base64.b64encode(s).decode("utf-8"))
                elif isinstance(s, str):
                    screenshots.append(s)  # already base64

        return RunResponse(
            ok=True,
            result=str(final) if final is not None else None,
            history=history_compact,
            screenshots=screenshots,
            steps=steps,
        )
    except Exception as e:  # noqa: BLE001
        logging.exception("browser-use run failed")
        return RunResponse(ok=False, error=str(e), history=[], steps=0)
    finally:
        try:
            await session.close()
        except Exception:  # noqa: BLE001
            pass


def main():
    port = int(os.getenv("BROWSERUSE_PORT", "5099"))
    host = os.getenv("BROWSERUSE_HOST", "127.0.0.1")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    logging.info(f"browser-use sidecar starting on http://{host}:{port}")
    logging.info(f"  LLM model: {LLM_MODEL} @ {LLM_BASE_URL}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
