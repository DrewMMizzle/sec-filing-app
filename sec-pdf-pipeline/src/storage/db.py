"""Postgres metadata storage using async SQLAlchemy + asyncpg.

Tracks every discovered filing and its processing status through the
pipeline: pending -> processing -> completed | failed.
"""

from __future__ import annotations

import enum
import logging
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from typing import AsyncGenerator, Sequence

from sqlalchemy import (
    String,
    Text,
    Date,
    DateTime,
    Enum,
    Integer,
    select,
    func,
)
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from src.config import get_settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# ORM Model
# ---------------------------------------------------------------------------

class FilingStatus(str, enum.Enum):
    """Processing status of a filing."""

    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class Base(DeclarativeBase):
    pass


class Filing(Base):
    """Represents a single SEC filing and its pipeline state."""

    __tablename__ = "filings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cik: Mapped[str] = mapped_column(String(10), index=True, nullable=False)
    ticker: Mapped[str] = mapped_column(String(10), nullable=False)
    accession_number: Mapped[str] = mapped_column(String(25), unique=True, nullable=False)
    filing_type: Mapped[str] = mapped_column(String(20), nullable=False)
    filing_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    filed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    primary_doc_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    s3_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[FilingStatus] = mapped_column(
        Enum(FilingStatus, name="filing_status", create_constraint=True, native_enum=False),
        default=FilingStatus.PENDING,
        nullable=False,
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), onupdate=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return (
            f"<Filing {self.ticker} {self.filing_type} "
            f"{self.accession_number} [{self.status.value}]>"
        )


# ---------------------------------------------------------------------------
# Engine / Session factory
# ---------------------------------------------------------------------------

_engine = None
_session_factory = None


def _get_engine():
    global _engine
    if _engine is None:
        settings = get_settings()
        kwargs: dict = {"echo": False}
        # SQLite doesn't support pool_size / max_overflow.
        if "sqlite" not in settings.database_url:
            kwargs["pool_size"] = 5
            kwargs["max_overflow"] = 10
        _engine = create_async_engine(settings.database_url, **kwargs)
    return _engine


def _get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            _get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )
    return _session_factory


@asynccontextmanager
async def async_session() -> AsyncGenerator[AsyncSession, None]:
    """Provide a transactional async session scope."""
    factory = _get_session_factory()
    session = factory()
    try:
        yield session
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


async def init_db() -> None:
    """Create all tables if they don't exist."""
    engine = _get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database tables initialized")


# ---------------------------------------------------------------------------
# CRUD helpers
# ---------------------------------------------------------------------------

async def create_filing(
    session: AsyncSession,
    *,
    cik: str,
    ticker: str,
    accession_number: str,
    filing_type: str,
    filing_date: date | None = None,
    filed_at: datetime | None = None,
    primary_doc_url: str | None = None,
) -> Filing:
    """Insert a new filing record with ``pending`` status."""
    filing = Filing(
        cik=cik,
        ticker=ticker,
        accession_number=accession_number,
        filing_type=filing_type,
        filing_date=filing_date,
        filed_at=filed_at,
        primary_doc_url=primary_doc_url,
        status=FilingStatus.PENDING,
    )
    session.add(filing)
    await session.flush()
    logger.info("Created filing record: %s", filing)
    return filing


async def filing_exists(session: AsyncSession, accession_number: str) -> bool:
    """Check whether a filing with the given accession number already exists."""
    stmt = select(Filing.id).where(Filing.accession_number == accession_number)
    result = await session.execute(stmt)
    return result.scalar_one_or_none() is not None


async def get_latest_filing_date(session: AsyncSession, cik: str) -> date | None:
    """Return the most recent filing_date for a CIK, or ``None``."""
    stmt = (
        select(func.max(Filing.filing_date))
        .where(Filing.cik == cik)
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def get_filing_by_accession(
    session: AsyncSession, accession_number: str
) -> Filing | None:
    """Fetch a single filing by accession number."""
    stmt = select(Filing).where(Filing.accession_number == accession_number)
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def list_filings(
    session: AsyncSession,
    *,
    cik: str | None = None,
    ticker: str | None = None,
    filing_type: str | None = None,
    status: FilingStatus | None = None,
    limit: int = 50,
    offset: int = 0,
) -> Sequence[Filing]:
    """List filings with optional filters and pagination."""
    stmt = select(Filing).order_by(Filing.filing_date.desc())

    if cik is not None:
        stmt = stmt.where(Filing.cik == cik)
    if ticker is not None:
        stmt = stmt.where(Filing.ticker == ticker)
    if filing_type is not None:
        stmt = stmt.where(Filing.filing_type == filing_type)
    if status is not None:
        stmt = stmt.where(Filing.status == status)

    stmt = stmt.limit(limit).offset(offset)
    result = await session.execute(stmt)
    return result.scalars().all()


async def update_filing_status(
    session: AsyncSession,
    accession_number: str,
    status: FilingStatus,
    *,
    s3_key: str | None = None,
    error_message: str | None = None,
) -> Filing | None:
    """Update the processing status of a filing.

    Args:
        session: Active async session.
        accession_number: Filing to update.
        status: New status.
        s3_key: Set when status is COMPLETED.
        error_message: Set when status is FAILED.

    Returns:
        The updated Filing, or ``None`` if not found.
    """
    filing = await get_filing_by_accession(session, accession_number)
    if filing is None:
        logger.warning("Filing not found for update: %s", accession_number)
        return None

    filing.status = status
    if s3_key is not None:
        filing.s3_key = s3_key
    if error_message is not None:
        filing.error_message = error_message
    filing.updated_at = datetime.now(timezone.utc)

    await session.flush()
    logger.info("Updated filing %s -> %s", accession_number, status.value)
    return filing


async def count_by_status(session: AsyncSession) -> dict[str, int]:
    """Return a mapping of status -> count for all filings."""
    stmt = (
        select(Filing.status, func.count(Filing.id))
        .group_by(Filing.status)
    )
    result = await session.execute(stmt)
    return {row[0].value: row[1] for row in result.all()}
