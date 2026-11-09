"""FastAPI entry point.

Run from the `backend/` directory:
    uvicorn main:app --reload --port 8000
"""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from fastapi import Depends, FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import RedirectResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from ai_service import (  # noqa: E402
    ExtractionError,
    LLMProvider,
    ProviderConfigError,
    get_provider,
)
from schemas import ExtractionResult, ExtractRequest  # noqa: E402

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

STATIC_DIR = Path(__file__).parent / "static"
SAMPLES_DIR = Path(__file__).parent / "samples"

app = FastAPI(
    title="AI Email & Message Action-Item Extractor",
    version="0.1.0",
    description="Turns long emails and message threads into action items, questions, and a draft reply.",
)

# Chrome extensions call from `chrome-extension://<id>`; the demo page is same-origin.
# Extra origins can be added via ALLOWED_ORIGINS (comma-separated).
_extra_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000", *_extra_origins],
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


def provider_dependency() -> LLMProvider:
    try:
        return get_provider()
    except ProviderConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/health")
def health() -> dict:
    try:
        p = get_provider()
        return {"status": "ok", "provider": p.name, "model": p.model}
    except ProviderConfigError as exc:
        return {"status": "misconfigured", "detail": str(exc)}


@app.get("/api/samples")
def samples() -> dict[str, str]:
    """Sample inputs for the demo page, keyed by file name (e.g. "group_email")."""
    return {p.stem: p.read_text() for p in sorted(SAMPLES_DIR.glob("*.txt"))}


@app.post("/api/extract", response_model=ExtractionResult)
async def extract(req: ExtractRequest, provider: LLMProvider = Depends(provider_dependency)) -> ExtractionResult:
    try:
        return await provider.extract(req.text, req.tone)
    except ExtractionError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    @app.get("/", include_in_schema=False)
    def root() -> RedirectResponse:
        return RedirectResponse("/static/")
