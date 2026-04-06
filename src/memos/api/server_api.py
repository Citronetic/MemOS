import logging
import os

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.staticfiles import StaticFiles

from memos.api.exceptions import APIExceptionHandler
from memos.api.middleware.request_context import RequestContextMiddleware
from memos.api.routers.server_router import router as server_router


load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(
    title="MemOS Server REST APIs",
    description="A REST API for managing multiple users with MemOS Server.",
    version="1.0.1",
)

app.mount("/download", StaticFiles(directory=os.getenv("FILE_LOCAL_PATH")), name="static_mapping")

app.add_middleware(RequestContextMiddleware, source="server_api")
# Include routers
app.include_router(server_router)


@app.get("/health")
def health_check():
    """Container and load balancer health endpoint."""
    return {
        "status": "healthy",
        "service": "memos",
        "version": app.version,
    }


# ---------------------------------------------------------------------------
# Cloud API compatibility layer
# The OpenClaw memos-cloud plugin calls /api/openmem/v1/search/memory and
# /api/openmem/v1/add/message. These routes forward to the existing product
# handlers so the same self-hosted MemOS works with the cloud plugin.
# ---------------------------------------------------------------------------
from fastapi import Request as FastAPIRequest  # noqa: E402
from memos.api.product_models import APISearchRequest, APIADDRequest  # noqa: E402
from memos.api.routers.server_router import search_handler, add_handler  # noqa: E402

cloud_router = APIRouter(prefix="/api/openmem/v1", tags=["Cloud Compat"])


@cloud_router.post("/search/memory")
def cloud_search_memory(search_req: APISearchRequest):
    """Cloud API compat: forwards to /product/search."""
    return search_handler.handle_search_memories(search_req)


@cloud_router.post("/add/message")
async def cloud_add_message(request: FastAPIRequest):
    """Cloud API compat: forwards to /product/add.

    Converts cloud plugin format to self-hosted format:
    - async_mode: true/false (boolean) -> "async"/"sync" (string literal)
    """
    import json
    body = await request.json()
    # Cloud plugin sends async_mode as boolean, self-hosted expects "async"/"sync"
    if "async_mode" in body:
        if body["async_mode"] is True:
            body["async_mode"] = "async"
        elif body["async_mode"] is False:
            body["async_mode"] = "sync"
    add_req = APIADDRequest(**body)
    return add_handler.handle_add_memories(add_req)


app.include_router(cloud_router)


# Request validation failed
app.exception_handler(RequestValidationError)(APIExceptionHandler.validation_error_handler)
# Invalid business code parameters
app.exception_handler(ValueError)(APIExceptionHandler.value_error_handler)
# Business layer manual exception
app.exception_handler(HTTPException)(APIExceptionHandler.http_error_handler)
# Fallback for unknown errors
app.exception_handler(Exception)(APIExceptionHandler.global_exception_handler)


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    uvicorn.run("memos.api.server_api:app", host="0.0.0.0", port=args.port, workers=args.workers)
