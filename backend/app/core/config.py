"""Application configuration loaded from environment variables (see .env.example)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(str(REPO_DIR / ".env"), str(BACKEND_DIR / ".env")),
        env_file_encoding="utf-8",
        extra="ignore",
        env_ignore_empty=True,  # `KEY=` in .env means "use the default"
    )

    # --- runtime -------------------------------------------------------
    app_env: Literal["development", "test", "production"] = "development"
    app_name: str = "OmniPulse AI"
    log_level: str = "INFO"
    log_json: bool = False
    demo_mode: bool = True

    # --- database / cache ---------------------------------------------
    database_url: str = f"sqlite:///{(BACKEND_DIR / 'omnipulse.db').as_posix()}"
    database_echo: bool = False
    redis_url: str | None = None

    # --- auth ------------------------------------------------------------
    jwt_secret: str = "dev-only-insecure-secret-change-me-0123456789"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 60 * 12
    session_cookie_name: str = "op_session"
    cookie_secure: bool = False
    cookie_samesite: Literal["lax", "strict", "none"] = "lax"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"])
    login_rate_limit_per_minute: int = 10
    invitation_ttl_hours: int = 72

    # --- AI providers ----------------------------------------------------
    ai_provider: Literal["demo", "openai", "gemini"] = "demo"
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    openai_chat_model: str = "gpt-4.1-mini"
    openai_embedding_model: str = "text-embedding-3-small"
    gemini_api_key: str | None = None
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    gemini_chat_model: str = "gemini-2.5-flash"
    gemini_embedding_model: str = "gemini-embedding-001"
    embedding_dimensions: int = 256
    ai_request_timeout_seconds: float = 30.0

    # --- integrations ----------------------------------------------------
    weather_provider: Literal["simulated", "openweathermap"] = "simulated"
    openweather_api_key: str | None = None
    pricing_publisher: Literal["simulated"] = "simulated"
    email_provider: Literal["log", "smtp"] = "log"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "no-reply@omnipulse.local"
    sms_provider: Literal["log"] = "log"
    push_provider: Literal["log"] = "log"

    # --- uploads / media -------------------------------------------------
    media_dir: Path = BACKEND_DIR / "media"
    # Where the seed writes the sample import CSV and demo query photos.
    sample_data_dir: Path = REPO_DIR / "data" / "sample"
    max_upload_mb: int = 5
    max_csv_rows: int = 5000

    # --- background jobs -------------------------------------------------
    run_worker_in_process: bool = True
    worker_poll_seconds: float = 2.0
    enable_scheduler: bool = True
    # Execute jobs synchronously at enqueue time (used by the test-suite and scripts).
    jobs_eager: bool = False

    frontend_base_url: str = "http://localhost:5173"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip().startswith("["):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    def validate_production(self) -> None:
        if self.app_env == "production":
            if self.jwt_secret.startswith("dev-only") or len(self.jwt_secret) < 32:
                raise RuntimeError("JWT_SECRET must be set to a strong secret in production")
            if not self.cookie_secure:
                raise RuntimeError("COOKIE_SECURE must be true in production")


@lru_cache
def get_settings() -> Settings:
    return Settings()
